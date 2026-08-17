import { randomUUID } from "node:crypto";
import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { synthesizeCheck } from "../analysis/synthesize-check.js";
import { classifyTask } from "../analysis/task-routing.js";
import {
  checkAnalysisPrefix,
  checkArtifactPrefix,
  checkChildrenPrefix,
  checkHeaderKey,
  checkTimelineGsi,
  GSI1_NAME,
  sitePk,
  taskKey,
  taskWorklistGsi,
} from "./keys.js";

/**
 * POST /v1/checks — start a perimeter run (one CHECK header per full run across
 * all sides). The client mints the ULID `checkId` and sends it as the
 * `idempotency-key` header — the same idempotency contract the offline app
 * already uses — so the write is conditional on that id and an offline replay
 * can't create a duplicate header. `siteId` is derived server-side from the JWT,
 * never from the body.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const createCheck = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.headers["idempotency-key"];
  if (!checkId) {
    return jsonResponse(400, { error: "Missing idempotency-key header" });
  }

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const { sides } = /** @type {{ sides?: unknown }} */ (body ?? {});

  const startedAt = new Date().toISOString();
  const item = {
    ...checkHeaderKey(siteId, checkId),
    ...checkTimelineGsi(siteId, startedAt),
    checkId,
    status: "in_progress",
    startedAt,
    issueCount: 0,
    maxSeverity: 0,
    ...(Array.isArray(sides) ? { sides } : {}),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: dynamoTable,
        Item: item,
        // pk is the shared tenant partition — condition on sk (the unique part).
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    return jsonResponse(201, { checkId, status: "in_progress", startedAt });
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // Idempotent replay: the check already exists. Treat as success.
      return jsonResponse(200, { checkId, status: "in_progress" });
    }
    throw err;
  }
};

/**
 * POST /v1/checks/{checkId}/complete — close out a perimeter run: fold every
 * analyzed artifact into one scorecard (worst grade across sides, per-category
 * max rating), classify each category into an action item via the placeholder
 * escalation matrix, and persist the header scorecard + tasks atomically.
 *
 * The header update is conditional on the check not already being `completed`,
 * so a replay can't mint a second set of tasks — and because the whole write is
 * one TransactWrite, either the scorecard and all its tasks land together or
 * nothing does. Failed-analysis markers carry no `concerns`, so they are
 * excluded from synthesis here.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const completeCheck = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });

  // Pull just this check's ANALYSIS# items and keep the ones that analyzed
  // cleanly (a "failed" marker has no concerns to synthesize).
  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": sitePk(siteId),
        ":prefix": checkAnalysisPrefix(checkId),
      },
    }),
  );
  const analyzed =
    /** @type {import("../analysis/synthesize-check.js").AnalyzedArtifact[]} */ (
      (result.Items ?? [])
        .filter((it) => it.status === "analyzed")
        .map((it) => ({
          artifactId: it.artifactId,
          side: it.side,
          adapted: it,
        }))
    );

  const scorecard = synthesizeCheck(analyzed);

  const now = new Date().toISOString();

  // One action item per concerning category, routed by the placeholder matrix.
  /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */
  const taskPuts = [];
  for (const category of scorecard.categories) {
    const type = classifyTask(category.category, category.maxRating);
    if (!type) continue;
    const taskId = randomUUID();
    taskPuts.push({
      Put: {
        TableName: dynamoTable,
        Item: {
          ...taskKey(siteId, taskId),
          ...taskWorklistGsi(siteId, "open", category.maxRating, now),
          taskId,
          checkId,
          type,
          category: category.category,
          severity: category.maxRating,
          status: "open",
          sourceArtifactIds: category.sourceArtifactIds,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(sk)",
      },
    });
  }

  /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>[number]} */
  const headerUpdate = {
    Update: {
      TableName: dynamoTable,
      Key: checkHeaderKey(siteId, checkId),
      UpdateExpression:
        "SET #status = :completed, grade = :grade, categories = :categories, rubricVersion = :rubricVersion, issueCount = :issueCount, maxSeverity = :maxSeverity, synthesizedAt = :now, completedAt = :now",
      // Complete exactly once: the header must exist and not already be closed.
      ConditionExpression: "attribute_exists(sk) AND #status <> :completed",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":completed": "completed",
        ":grade": scorecard.grade,
        ":categories": scorecard.categories,
        ":rubricVersion": scorecard.rubricVersion,
        ":issueCount": scorecard.issueCount,
        ":maxSeverity": scorecard.maxSeverity,
        ":now": now,
      },
    },
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [headerUpdate, ...taskPuts],
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      // Already completed (idempotent replay) — the header condition held it
      // back, so no duplicate tasks were created.
      return jsonResponse(200, { checkId, status: "completed" });
    }
    throw err;
  }

  return jsonResponse(200, {
    checkId,
    status: "completed",
    grade: scorecard.grade,
    issueCount: scorecard.issueCount,
    maxSeverity: scorecard.maxSeverity,
    taskCount: taskPuts.length,
  });
};

// Opaque pagination cursor: the DynamoDB LastEvaluatedKey round-tripped as
// base64 JSON so clients pass it back verbatim without seeing key internals.
/**
 * @param {Record<string, unknown> | undefined} key
 * @returns {string | undefined}
 */
const encodeCursor = (key) =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;

/**
 * @param {string | undefined} token
 * @returns {Record<string, unknown> | undefined}
 */
const decodeCursor = (token) => {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

/**
 * GET /v1/checks — the site's checks, newest first, over GSI1 (the sparse
 * timeline index carried only by CHECK headers, so no filtering). Supports an
 * optional `limit` and an opaque `nextToken` cursor for paging.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const listChecks = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const rawLimit = Number(event.queryStringParameters?.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : undefined;
  const startKey = decodeCursor(event.queryStringParameters?.nextToken);

  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      IndexName: GSI1_NAME,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": sitePk(siteId) },
      ScanIndexForward: false, // newest startedAt first
      ...(limit ? { Limit: limit } : {}),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );

  const nextToken = encodeCursor(result.LastEvaluatedKey);
  return jsonResponse(200, {
    checks: result.Items ?? [],
    ...(nextToken ? { nextToken } : {}),
  });
};

/**
 * GET /v1/checks/{checkId} — one check with its artifacts and analyses, read in
 * a single base-table query (`begins_with(sk, "CHECK#<id>")` gathers the header
 * and every child). 404 when the header is absent for this site.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getCheck = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });

  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": sitePk(siteId),
        ":prefix": checkChildrenPrefix(checkId),
      },
    }),
  );

  const items = result.Items ?? [];
  const headerSk = checkHeaderKey(siteId, checkId).sk;
  const header = items.find((it) => it.sk === headerSk);
  if (!header) return jsonResponse(404, { error: "Check not found" });

  const artifactPrefix = checkArtifactPrefix(checkId);
  const analysisPrefix = checkAnalysisPrefix(checkId);
  return jsonResponse(200, {
    check: header,
    artifacts: items.filter((it) => it.sk.startsWith(artifactPrefix)),
    analyses: items.filter((it) => it.sk.startsWith(analysisPrefix)),
  });
};
