import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { jsonResponse } from "../http.js";
import { adminPrincipal, supervisorOnly } from "../lib/admin-auth.js";
import {
  compilePolicy,
  isPolicyDocument,
  policyTexts,
  validatePolicy,
} from "../analysis/guidance/policy-document.js";
import {
  exportPolicyCsv,
  importPolicyCsv,
  initialPolicyDocument,
} from "../analysis/guidance/policy-import.js";
import { activeCatalog } from "../analysis/guidance/catalog-registry.js";
import { diffCatalogs } from "../analysis/guidance/rulebase-diff.js";
import { evaluateCondition } from "../analysis/guidance/evaluator.js";
import { RUBRIC_ID, RUBRIC_VERSION } from "../analysis/contract.js";

const pk = "POLICY_EDITOR";
const MAX_BYTES = 280000; // Below DynamoDB's 400 KB item limit, with room for metadata.
/** @param {string} sk */
const key = (sk) => ({ pk, sk });
/** @param {string} sk */
async function get(sk) {
  return (
    await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: key(sk),
        ConsistentRead: true,
      }),
    )
  ).Item;
}
/** @param {unknown} value */
const fits = (value) =>
  Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES;
/** @param {unknown} error */
const conflict = (error) =>
  error instanceof Error &&
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    error.name,
  );

/** Authenticate before validating request shape or touching the database.
 * @param {import('aws-lambda').APIGatewayProxyEventV2} event
 * @param {(body:Record<string,unknown>)=>Promise<any>} fn
 */
function policyOnly(event, fn) {
  return supervisorOnly(event, async (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return jsonResponse(400, { error: "invalid_policy_request" });
    if (!fits(body)) return jsonResponse(413, { error: "policy_too_large" });
    return fn(body);
  });
}

/** Draft preview is lazy and read-only until explicitly saved. @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const getPolicyDraft = (event) =>
  policyOnly(event, async () => {
    const draft = await get("DRAFT");
    return jsonResponse(200, {
      draft: draft ?? { revision: 0, document: initialPolicyDocument() },
      activeVersion: activeCatalog().policyVersion,
      analyzer: { id: RUBRIC_ID, version: RUBRIC_VERSION },
      activationAvailable: false,
    });
  });

/** @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const savePolicyDraft = (event) =>
  policyOnly(event, async (body) => {
    if (
      !isPolicyDocument(body.document) ||
      !Number.isInteger(body.revision) ||
      Number(body.revision) < 0
    )
      return jsonResponse(400, { error: "invalid_policy_document" });
    if (!fits(body.document))
      return jsonResponse(413, { error: "policy_too_large" });
    const prior = await get("DRAFT");
    if ((prior?.revision ?? 0) !== body.revision)
      return jsonResponse(409, { error: "policy_revision_conflict" });
    // IDs are stable within a draft lineage; a rename retains the old analyzer name.
    const document = structuredClone(body.document);
    if (prior?.document)
      for (const category of document.categories) {
        const previous = prior.document.categories.find(
          (/** @type {{id:string}} */ c) => c.id === category.id,
        );
        if (
          previous &&
          previous.name !== category.name &&
          !category.aliases.includes(previous.name)
        )
          category.aliases.push(previous.name);
      }
    // Changed source text invalidates its translations, even if a caller accidentally resubmits them.
    if (prior?.document) {
      const before = policyTexts(prior.document),
        after = policyTexts(document);
      for (const [locale, values] of Object.entries(document.translations))
        for (const field of Object.keys(values))
          if (
            before[field] !== after[field] &&
            values[field] === prior.document.translations[locale]?.[field]
          )
            delete values[field];
    }
    const draft = {
      ...key("DRAFT"),
      type: "policyDraft",
      revision: Number(body.revision) + 1,
      document,
      updatedAt: new Date().toISOString(),
      updatedBy:
        adminPrincipal(event).subject || adminPrincipal(event).username,
    };
    if (!fits(draft)) return jsonResponse(413, { error: "policy_too_large" });
    try {
      await ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: draft,
          ConditionExpression: prior
            ? "revision = :revision"
            : "attribute_not_exists(pk)",
          ...(prior
            ? { ExpressionAttributeValues: { ":revision": body.revision } }
            : {}),
        }),
      );
      return jsonResponse(200, { draft });
    } catch (error) {
      if (conflict(error))
        return jsonResponse(409, { error: "policy_revision_conflict" });
      throw error;
    }
  });

/** @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const validatePolicyDraft = (event) =>
  policyOnly(event, async (body) => {
    if (!isPolicyDocument(body.document))
      return jsonResponse(400, { error: "invalid_policy_document" });
    if (!fits(body.document))
      return jsonResponse(413, { error: "policy_too_large" });
    const document = body.document;
    const baseline = initialPolicyDocument();
    const report = validatePolicy(document, {
      translations: body.translations === true,
    });
    return jsonResponse(200, {
      ...report,
      diff: diffCatalogs(compilePolicy(baseline), compilePolicy(document)),
      categoryChanges: document.categories.flatMap((category) => {
        const prior = baseline.categories.find((c) => c.id === category.id);
        return Object.entries(category)
          .filter(
            ([field, value]) =>
              field !== "id" &&
              JSON.stringify(
                prior?.[
                  /** @type {keyof import('../analysis/guidance/policy-document.js').PolicyCategory} */ (
                    field
                  )
                ],
              ) !== JSON.stringify(value),
          )
          .map(([field, after]) => ({
            categoryId: category.id,
            category: category.name,
            field,
            before:
              prior?.[
                /** @type {keyof import('../analysis/guidance/policy-document.js').PolicyCategory} */ (
                  field
                )
              ] ?? null,
            after,
          }));
      }),
      removedCategories: baseline.categories
        .filter((c) => !document.categories.some((next) => next.id === c.id))
        .map((c) => c.name),
    });
  });

/** @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const previewPolicyScenario = (event) =>
  policyOnly(event, async (body) => {
    if (!isPolicyDocument(body.document) || !fits(body.document))
      return jsonResponse(400, { error: "invalid_policy_document" });
    const validation = validatePolicy(body.document);
    // Structural errors prevent compilation; overlaps and gaps are exactly what preview helps inspect.
    if (
      validation.issues.some(
        (i) =>
          ![
            "coverageGap",
            "overlap",
            "unreachable",
            "tooManyQuestions",
          ].includes(i.code),
      )
    )
      return jsonResponse(422, { error: "policy_invalid", report: validation });
    const scenario = /** @type {Record<string,any>} */ (body.scenario ?? {});
    if (
      !Number.isInteger(scenario.severity) ||
      scenario.severity < 0 ||
      scenario.severity > 5 ||
      typeof scenario.category !== "string" ||
      typeof scenario.reportedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        scenario.reportedAt,
      ) ||
      !Number.isFinite(Date.parse(scenario.reportedAt)) ||
      !scenario.answers ||
      typeof scenario.answers !== "object" ||
      Array.isArray(scenario.answers) ||
      Object.values(scenario.answers).some((v) => typeof v !== "boolean")
    )
      return jsonResponse(400, { error: "invalid_policy_scenario" });
    const baseline = initialPolicyDocument();
    const category = body.document.categories.find(
      (c) => c.name === scenario.category,
    );
    return jsonResponse(200, {
      previous: evaluateCondition({
        condition: {
          category:
            baseline.categories.find((c) => c.id === category?.id)?.name ??
            scenario.category,
          severity: scenario.severity,
        },
        answers: scenario.answers,
        reportedAt: scenario.reportedAt,
        catalog: compilePolicy(baseline),
      }),
      result: evaluateCondition({
        condition: { category: scenario.category, severity: scenario.severity },
        answers: scenario.answers,
        reportedAt: scenario.reportedAt,
        catalog: compilePolicy(body.document),
      }),
    });
  });

/** CSV migration returns a draft preview; it never writes or activates a policy. @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const importPolicyDraft = (event) =>
  policyOnly(event, async (body) => {
    if (
      typeof body.categoriesCsv !== "string" ||
      typeof body.rulesCsv !== "string" ||
      !fits(body)
    )
      return jsonResponse(400, { error: "invalid_policy_import" });
    try {
      const document = importPolicyCsv(body.categoriesCsv, body.rulesCsv);
      if (!isPolicyDocument(document) || !fits(document))
        return jsonResponse(400, { error: "invalid_policy_document" });
      return jsonResponse(200, { document, report: validatePolicy(document) });
    } catch {
      return jsonResponse(400, { error: "invalid_policy_import" });
    }
  });

/** Create an immutable, validated release package. Deliberately no activation pointer.
 * @type {import('aws-lambda').APIGatewayProxyHandlerV2}
 */
export const createPolicyRelease = (event) =>
  policyOnly(event, async (body) => {
    if (
      !Number.isInteger(body.revision) ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.length > 1000
    )
      return jsonResponse(400, { error: "policy_reason_required" });
    const draft = await get("DRAFT");
    if (!draft || draft.revision !== body.revision)
      return jsonResponse(409, { error: "policy_revision_conflict" });
    const report = validatePolicy(draft.document, { translations: true });
    if (!report.valid)
      return jsonResponse(422, { error: "policy_invalid", report });
    // A release must be based on the currently deployed app policy. Human updates are
    // never overwritten by a draft opened before a deployment.
    if (draft.document.baseVersion !== activeCatalog().policyVersion)
      return jsonResponse(409, { error: "policy_base_changed" });
    const releaseId = randomUUID(),
      now = new Date().toISOString();
    const digest = createHash("sha256")
      .update(JSON.stringify(draft.document))
      .digest("hex");
    const release = {
      ...key(`RELEASE#${releaseId}`),
      type: "policyRelease",
      releaseId,
      document: draft.document,
      catalog: compilePolicy(draft.document, `policy-${releaseId}`),
      ...exportPolicyCsv(draft.document),
      analyzerBase: { id: RUBRIC_ID, version: RUBRIC_VERSION },
      activationPrerequisites: [
        "publish_analyzer_rubric",
        "verify_category_contract",
        "integrate_policy_translations",
        "deploy_bound_policy_versions",
      ],
      digest,
      baseVersion: draft.document.baseVersion,
      reason: body.reason.trim(),
      createdAt: now,
      createdBy:
        adminPrincipal(event).subject || adminPrincipal(event).username,
      status: "prepared",
      activationAvailable: false,
    };
    if (!fits(release)) return jsonResponse(413, { error: "policy_too_large" });
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: getDynamoTableName(),
                Item: release,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: getDynamoTableName(),
                Key: key("DRAFT"),
                UpdateExpression: "SET revision = :next, lastReleaseId = :id",
                ConditionExpression: "revision = :revision",
                ExpressionAttributeValues: {
                  ":next": draft.revision + 1,
                  ":id": releaseId,
                  ":revision": draft.revision,
                },
              },
            },
          ],
        }),
      );
      return jsonResponse(201, {
        release: {
          ...release,
          document: undefined,
          catalog: undefined,
          categoriesCsv: undefined,
          rulesCsv: undefined,
        },
        revision: draft.revision + 1,
      });
    } catch (error) {
      if (conflict(error))
        return jsonResponse(409, { error: "policy_revision_conflict" });
      throw error;
    }
  });

/** @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const listPolicyReleases = (event) =>
  policyOnly(event, async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "RELEASE#" },
        ProjectionExpression:
          "releaseId, createdAt, createdBy, reason, digest, baseVersion, #status",
        ExpressionAttributeNames: { "#status": "status" },
        Limit: 100,
        ExclusiveStartKey: undefined,
      }),
    );
    return jsonResponse(200, {
      releases: result.Items ?? [],
      truncated: !!result.LastEvaluatedKey,
    });
  });

/** @type {import('aws-lambda').APIGatewayProxyHandlerV2} */
export const getPolicyRelease = (event) =>
  policyOnly(event, async () => {
    const id = event.pathParameters?.releaseId ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id))
      return jsonResponse(400, { error: "invalid_policy_release" });
    const release = await get(`RELEASE#${id}`);
    if (!release) return jsonResponse(404, { error: "not_found" });
    return jsonResponse(200, {
      release,
      package: {
        schemaVersion: 1,
        releaseId: id,
        digest: release.digest,
        activationAvailable: false,
        activationPrerequisites: release.activationPrerequisites,
        analyzerBase: release.analyzerBase,
        document: release.document,
        catalog: release.catalog,
        categoriesCsv: release.categoriesCsv,
        rulesCsv: release.rulesCsv,
      },
    });
  });
