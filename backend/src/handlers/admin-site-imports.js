import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { geocodeSiteAddress, siteSearchItem } from "../domain/site-metadata.js";
import { jsonResponse } from "../http.js";
import { GeocodingError } from "../integrations/census-geocoder.js";
import { supervisorOnly } from "../lib/admin-auth.js";
import { emailHash } from "./setup-codes.js";

const HEADERS = [
  "Provider",
  "Program",
  "Site name",
  "Site address",
  "Site type",
  "Department",
  "Site manager first name",
  "Site manager last name",
  "Site manager phone",
  "Site manager extension",
  "Site manager email",
  "Program manager first name",
  "Program manager last name",
  "Program manager phone",
  "Program manager extension",
  "Program manager department",
  "Program manager email",
  "Provider manager first name",
  "Provider manager last name",
  "Provider manager phone",
  "Provider manager extension",
  "Provider manager email",
];
const OPTIONAL_HEADERS = HEADERS.filter(
  (header) =>
    header.endsWith(" extension") ||
    (header.endsWith(" phone") && header !== "Program manager phone"),
);
const REQUIRED_HEADERS = HEADERS.filter(
  (header) => !OPTIONAL_HEADERS.includes(header),
);
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_APPLY_ROWS = 20;
const REVIEW_SECONDS = 7 * 24 * 60 * 60;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const previewSiteImport = (event) =>
  supervisorOnly(event, async (body) => {
    const csv = String(body.csv ?? "");
    if (!csv || Buffer.byteLength(csv, "utf8") > MAX_BYTES) {
      return jsonResponse(400, { error: "invalid_file_size" });
    }
    if (csv.includes("\uFFFD")) {
      return jsonResponse(400, { error: "invalid_encoding" });
    }
    let parsed;
    try {
      parsed = parseCsv(csv.replace(/^\uFEFF/, ""));
    } catch {
      return jsonResponse(400, { error: "unreadable_csv" });
    }
    if (!sameHeaders(parsed.headers, HEADERS)) {
      return jsonResponse(400, {
        error: "invalid_headers",
        expectedHeaders: HEADERS,
      });
    }
    if (!parsed.rows.length || parsed.rows.length > MAX_ROWS) {
      return jsonResponse(400, { error: "invalid_row_count" });
    }
    const catalog = await loadCatalog();
    const planned = planRows(parsed.rows, catalog);
    const importId = randomUUID();
    const previewVersion = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REVIEW_SECONDS * 1000);
    const digest = createHash("sha256").update(csv).digest("hex");
    const counts = countClassifications(planned);
    const requester = String(
      /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
        "central-admin",
    );
    const ledgerItems = [
      {
        pk: `SITE_IMPORT#${importId}`,
        sk: "#META",
        type: "siteImport",
        importId,
        sourceDigest: digest,
        fileName: clean(body.fileName).slice(0, 200),
        previewVersion,
        previewExpiresAt: expiresAt.toISOString(),
        expiresAt: Math.floor(expiresAt.getTime() / 1000),
        requester,
        status: "previewed",
        counts,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      ...planned.map((row) => ({
        pk: `SITE_IMPORT#${importId}`,
        sk: `ROW#${String(row.rowNumber).padStart(6, "0")}`,
        type: "siteImportRow",
        importId,
        ...row,
        expiresAt: Math.floor(expiresAt.getTime() / 1000),
      })),
    ];
    await batchPut(ledgerItems);
    return jsonResponse(201, {
      importId,
      previewVersion,
      previewExpiresAt: expiresAt.toISOString(),
      counts,
      rows: planned.map(publicRow),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const applySiteImport = (event) =>
  supervisorOnly(event, async (body) => {
    const importId = event.pathParameters?.importId ?? "";
    const previewVersion = clean(body.previewVersion);
    const idempotencyKey = clean(body.idempotencyKey);
    if (!previewVersion || !idempotencyKey) {
      return jsonResponse(400, { error: "confirmation_required" });
    }
    const tableName = getDynamoTableName();
    const [metaResult, rowsResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE_IMPORT#${importId}`, sk: "#META" },
        }),
      ),
      queryImportRows(importId),
    ]);
    const meta = metaResult.Item;
    if (!meta) return jsonResponse(404, { error: "import_not_found" });
    if (
      meta.previewVersion !== previewVersion ||
      String(meta.previewExpiresAt) <= new Date().toISOString()
    ) {
      return jsonResponse(409, { error: "stale_preview" });
    }
    if (meta.idempotencyKey && meta.idempotencyKey !== idempotencyKey) {
      return jsonResponse(409, { error: "idempotency_key_conflict" });
    }
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: `SITE_IMPORT#${importId}`, sk: "#META" },
        UpdateExpression:
          "SET #status = :applying, idempotencyKey = if_not_exists(idempotencyKey, :key), confirmedCounts = if_not_exists(confirmedCounts, :counts), updatedAt = :now",
        ConditionExpression:
          "previewVersion = :version AND (attribute_not_exists(idempotencyKey) OR idempotencyKey = :key)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":applying": "applying",
          ":key": idempotencyKey,
          ":counts": meta.counts,
          ":now": new Date().toISOString(),
          ":version": previewVersion,
        },
      }),
    );
    const rows = rowsResult.Items ?? [];
    const pendingRows = rows
      .filter((row) => isApplicable(row) && !isTerminal(row))
      .slice(0, MAX_APPLY_ROWS);
    for (const row of pendingRows) {
      await applyOneRow(importId, row);
    }
    const finalRows = await queryImportRows(importId);
    const finalItems = finalRows.Items ?? [];
    const outcomes = countOutcomes(finalItems);
    const complete = !finalItems.some(
      (row) => isApplicable(row) && !isTerminal(row),
    );
    const now = new Date().toISOString();
    const completedAt = complete ? clean(meta.completedAt) || now : "";
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: `SITE_IMPORT#${importId}`, sk: "#META" },
        UpdateExpression:
          "SET #status = :status, outcomes = :outcomes, completedAt = :completedAt, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": complete ? "complete" : "applying",
          ":outcomes": outcomes,
          ":completedAt": completedAt,
          ":now": now,
        },
      }),
    );
    if (complete) {
      const added = finalItems.filter(
        (row) =>
          row.outcome === "applied" && row.plan?.site?.action === "create",
      ).length;
      const updated = finalItems.filter(
        (row) =>
          row.outcome === "applied" && row.plan?.site?.action !== "create",
      ).length;
      const failed =
        Number(outcomes.failed || 0) + Number(outcomes.skipped_conflict || 0);
      const resultStatus =
        failed === 0 ? "succeeded" : added + updated > 0 ? "partial" : "failed";
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: `SITE_IMPORT_HISTORY#${requesterId(event)}`,
            sk: `${completedAt}#${importId}`,
            type: "siteImportHistory",
            importId,
            fileName: String(meta.fileName || "Imported CSV"),
            completedAt,
            recordsAdded: added,
            recordsUpdated: updated,
            recordsFailed: failed,
            resultStatus,
            outcomes,
          },
        }),
      );
    }
    const failed =
      Number(outcomes.failed || 0) + Number(outcomes.skipped_conflict || 0);
    const applied = Number(outcomes.applied || 0);
    return jsonResponse(complete ? 200 : 202, {
      importId,
      status: complete ? "complete" : "applying",
      resultStatus: complete
        ? failed === 0
          ? "succeeded"
          : applied > 0
            ? "partial"
            : "failed"
        : "applying",
      outcomes,
      rows: finalItems.map(publicRow),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listSiteImports = (event) =>
  supervisorOnly(event, async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `SITE_IMPORT_HISTORY#${requesterId(event)}`,
        },
        ScanIndexForward: false,
        Limit: 25,
      }),
    );
    return jsonResponse(200, { imports: result.Items ?? [] });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getSiteImport = (event) =>
  supervisorOnly(event, async () => {
    const importId = event.pathParameters?.importId ?? "";
    const [meta, rows] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `SITE_IMPORT#${importId}`, sk: "#META" },
        }),
      ),
      queryImportRows(importId),
    ]);
    if (!meta.Item) return jsonResponse(404, { error: "import_not_found" });
    return jsonResponse(200, {
      import: meta.Item,
      rows: (rows.Items ?? []).map(publicRow),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getSiteImportConflicts = (event) =>
  supervisorOnly(event, async () => {
    const importId = event.pathParameters?.importId ?? "";
    const rows = await queryImportRows(importId);
    const conflicts = (rows.Items ?? []).filter(
      (row) =>
        row.classification === "conflict" ||
        row.classification === "invalid" ||
        row.outcome === "skipped_conflict" ||
        row.outcome === "failed",
    );
    const columns = [
      "Row",
      ...HEADERS,
      "Status",
      "Reason",
      "Correction guidance",
      "Existing value",
    ];
    const lines = [columns.map(csvCell).join(",")];
    for (const row of conflicts) {
      const source = /** @type {Record<string, unknown>} */ (row.source ?? {});
      lines.push(
        [
          row.rowNumber,
          ...HEADERS.map((header) => source[header] ?? ""),
          row.outcome || row.classification,
          row.reasonCode || "",
          guidance(String(row.reasonCode || "")),
          row.existingValue || "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="site-import-${importId}-conflicts.csv"`,
      },
      body: `${lines.join("\r\n")}\r\n`,
    };
  });

/** @param {string} importId @param {Record<string, unknown>} row */
async function applyOneRow(importId, row) {
  const plan = /** @type {Record<string, any>} */ (row.plan ?? {});
  const source = /** @type {Record<string, string>} */ (row.source ?? {});
  const contactEmail =
    clean(plan.contact?.email) || normalized(source["Site manager email"]);
  const tableName = getDynamoTableName();
  const now = new Date().toISOString();
  const actor = "site-import";
  /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
  const items = [];
  for (const department of uniqueBy(
    (plan.departments || []).filter(
      /** @param {Record<string, any>} item */
      (item) => item.action === "create",
    ),
    (item) => item.id,
  )) {
    items.push(
      conditionalPut({
        pk: "ADMIN_DIRECTORY#OVERSIGHT",
        sk: `DEPARTMENT#${department.id}`,
        type: "oversightDirectoryOption",
        optionType: "department",
        departmentId: department.id,
        name: department.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  if (plan.provider.action === "reuse") {
    items.push(
      activeMatch(
        { pk: `PROVIDER#${plan.provider.id}`, sk: "#META" },
        "#name = :name",
        { "#name": "name" },
        { ":name": plan.provider.name },
      ),
    );
  }
  if (plan.program.action === "reuse") {
    items.push(
      activeMatch(
        { pk: `PROGRAM#${plan.program.id}`, sk: "#META" },
        "providerId = :providerId AND #name = :name",
        { "#name": "name" },
        { ":providerId": plan.provider.id, ":name": plan.program.name },
      ),
    );
  }
  if (plan.site.action === "reuse") {
    items.push({
      Update: {
        TableName: tableName,
        Key: { pk: `SITE#${plan.site.id}`, sk: "#META" },
        UpdateExpression:
          "SET updatedAt = :now, siteType = if_not_exists(siteType, :siteType), oversight = :oversight",
        ConditionExpression:
          "attribute_exists(pk) AND #status = :active AND providerId = :providerId AND leadProgramId = :programId AND #name = :name AND address = :address AND (attribute_not_exists(siteType) OR siteType = :siteType) AND (attribute_not_exists(oversight) OR oversight = :expectedOversight)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#name": "name",
        },
        ExpressionAttributeValues: {
          ":now": now,
          ":active": "active",
          ":providerId": plan.provider.id,
          ":programId": plan.program.id,
          ":name": plan.site.name,
          ":address": plan.site.address,
          ":siteType": plan.site.siteType,
          ":oversight": plan.site.oversight,
          ":expectedOversight": plan.site.expectedOversight,
        },
      },
    });
  }
  if (
    plan.contact.action === "reuse" &&
    plan.assignment.action !== "create" &&
    !plan.contact.promote
  ) {
    items.push(
      activeMatch(
        {
          pk: `PROGRAM#${plan.program.id}`,
          sk: `USER#${plan.contact.id}`,
        },
        "email = :email",
        {},
        { ":email": contactEmail },
      ),
    );
  }
  if (plan.provider.action === "create") {
    items.push(
      conditionalPut({
        pk: `PROVIDER#${plan.provider.id}`,
        sk: "#META",
        type: "provider",
        entityType: "PROVIDER",
        providerId: plan.provider.id,
        name: source.Provider,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      conditionalPut({
        pk: "PROVIDER_SEARCH#ACTIVE",
        sk: plan.provider.id,
        type: "providerSearch",
        providerId: plan.provider.id,
        name: source.Provider,
        status: "active",
        updatedAt: now,
      }),
    );
  }
  if (plan.program.action === "create") {
    items.push(
      conditionalPut({
        pk: `PROGRAM#${plan.program.id}`,
        sk: "#META",
        type: "program",
        entityType: "PROGRAM",
        programId: plan.program.id,
        name: source.Program,
        providerId: plan.provider.id,
        providerName: source.Provider,
        contact: {},
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      conditionalPut({
        pk: `PROVIDER#${plan.provider.id}`,
        sk: `PROGRAM#${plan.program.id}`,
        type: "providerProgramMembership",
        providerId: plan.provider.id,
        programId: plan.program.id,
        programName: source.Program,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      conditionalPut({
        pk: "PROGRAM_SEARCH#ACTIVE",
        sk: `${normalized(source.Program)}#${plan.program.id}`,
        type: "programSearch",
        programId: plan.program.id,
        name: source.Program,
        providerId: plan.provider.id,
        providerName: source.Provider,
        status: "active",
        updatedAt: now,
      }),
    );
  }
  let geocoded;
  if (plan.site.action === "create") {
    geocoded = await geocodeSiteAddress(source["Site address"]);
    if (geocoded instanceof GeocodingError) {
      return recordOutcome(importId, row, "failed", geocoded.code);
    }
    const providerSiteId = `provider-site-${plan.site.id}`;
    items.push(
      conditionalPut({
        pk: `SITE#${plan.site.id}`,
        sk: "#META",
        type: "site",
        entityType: "SITE",
        siteId: plan.site.id,
        name: source["Site name"],
        address: source["Site address"],
        location: {
          latitude: geocoded.latitude,
          longitude: geocoded.longitude,
        },
        geocodedAddress: geocoded.matchedAddress,
        providerId: plan.provider.id,
        providerName: source.Provider,
        leadProgramId: plan.program.id,
        programName: source.Program,
        siteType: plan.site.siteType,
        oversight: {
          managingCityDepartment: plan.site.department.name,
          managingCityDepartmentId: plan.site.department.id,
        },
        providerSiteId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      conditionalPut({
        pk: `PROVIDER#${plan.provider.id}`,
        sk: `SITE#${plan.site.id}`,
        type: "providerSiteMembership",
        providerId: plan.provider.id,
        providerName: source.Provider,
        siteId: plan.site.id,
        siteName: source["Site name"],
        providerSiteId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      conditionalPut({
        pk: `PROGRAM#${plan.program.id}`,
        sk: `SITE#${plan.site.id}`,
        type: "programSiteMembership",
        programId: plan.program.id,
        programName: source.Program,
        siteId: plan.site.id,
        siteName: source["Site name"],
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      conditionalPut(
        siteSearchItem(
          plan.site.id,
          source["Site name"],
          plan.provider.id,
          source.Provider,
          providerSiteId,
          now,
        ),
      ),
    );
  }
  if (plan.contact.action === "create") {
    items.push(
      conditionalPut({
        pk: `PROGRAM#${plan.program.id}`,
        sk: `USER#${plan.contact.id}`,
        type: "programUser",
        entityType: "PROGRAM_USER",
        programId: plan.program.id,
        userId: plan.contact.id,
        firstName: source["Site manager first name"],
        lastName: source["Site manager last name"],
        phone: source["Site manager phone"],
        phoneExtension: source["Site manager extension"],
        email: normalized(source["Site manager email"]),
        siteManager: true,
        status: "active",
        siteAssignmentCount: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  } else if (plan.assignment.action === "create" || plan.contact.promote) {
    const addsAssignment = plan.assignment.action === "create";
    items.push({
      Update: {
        TableName: tableName,
        Key: {
          pk: `PROGRAM#${plan.program.id}`,
          sk: `USER#${plan.contact.id}`,
        },
        UpdateExpression: `${addsAssignment ? "ADD siteAssignmentCount :one " : ""}SET siteManager = :true, updatedAt = :now`,
        ConditionExpression:
          "attribute_exists(pk) AND #status = :active AND email = :email",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ...(addsAssignment ? { ":one": 1 } : {}),
          ":true": true,
          ":now": now,
          ":active": "active",
          ":email": contactEmail,
        },
      },
    });
  }
  if (plan.assignment.action === "create") {
    items.push(
      conditionalPut({
        pk: `SITE#${plan.site.id}`,
        sk: `ASSIGNED_USER#${plan.contact.id}`,
        type: "siteUserAssignment",
        siteId: plan.site.id,
        programId: plan.program.id,
        userId: plan.contact.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  const managerPlan = plan.manager || {
    id: stableId(`${plan.site.id}|${plan.contact.id}|manager-membership`),
    action: "create",
  };
  if (managerPlan.action === "reuse") {
    items.push(
      activeMatch(
        {
          pk: `SITE#${plan.site.id}`,
          sk: `MANAGER_MEMBERSHIP#${managerPlan.id}`,
        },
        "programId = :programId AND userId = :userId AND email = :email",
        {},
        {
          ":programId": plan.program.id,
          ":userId": plan.contact.id,
          ":email": contactEmail,
        },
      ),
    );
  } else {
    const verifier = await emailHash(contactEmail);
    const membership = {
      pk: `SITE#${plan.site.id}`,
      sk: `MANAGER_MEMBERSHIP#${managerPlan.id}`,
      type: "managerMembership",
      entityType: "MANAGER_MEMBERSHIP",
      membershipId: managerPlan.id,
      siteId: plan.site.id,
      programId: plan.program.id,
      userId: plan.contact.id,
      name: `${source["Site manager first name"]} ${source["Site manager last name"]}`.trim(),
      email: contactEmail,
      emailHash: verifier,
      role: "manager",
      status: "active",
      generation: 1,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
    };
    items.push(
      conditionalPut(membership),
      conditionalPut({
        pk: `SITE#${plan.site.id}`,
        sk: `MANAGER_EMAIL#${verifier}`,
        type: "managerMembershipEmail",
        membershipId: managerPlan.id,
        siteId: plan.site.id,
        createdAt: now,
      }),
      conditionalPut({
        pk: `MANAGER_EMAIL#${verifier}`,
        sk: `SITE#${plan.site.id}#MEMBERSHIP#${managerPlan.id}`,
        type: "managerMembershipDirectory",
        membershipId: managerPlan.id,
        siteId: plan.site.id,
        status: "active",
        createdAt: now,
      }),
      conditionalPut({
        pk: `SITE#${plan.site.id}`,
        sk: `AUDIT#${now}#${randomUUID()}`,
        type: "siteAuditEvent",
        eventType: "manager_membership_created",
        siteId: plan.site.id,
        membershipId: managerPlan.id,
        actor,
        createdAt: now,
      }),
    );
  }
  const complianceManager = plan.complianceManager;
  if (complianceManager.action === "reuse") {
    items.push({
      ConditionCheck: {
        TableName: tableName,
        Key: {
          pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
          sk: `MANAGER#${complianceManager.email}`,
        },
        ConditionExpression:
          "attribute_exists(pk) AND #status = :active AND email = :email AND userId = :userId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":email": complianceManager.email,
          ":userId": complianceManager.id,
        },
      },
    });
  } else {
    items.push(
      conditionalPut({
        pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
        sk: `MANAGER#${complianceManager.email}`,
        type: "cityProgramManager",
        entityType: "COMPLIANCE_MANAGER_DIRECTORY",
        userId: complianceManager.id,
        firstName: source["Program manager first name"],
        lastName: source["Program manager last name"],
        name: `${source["Program manager first name"]} ${source["Program manager last name"]}`.trim(),
        email: complianceManager.email,
        phone: source["Program manager phone"],
        phoneExtension: source["Program manager extension"],
        departmentId: complianceManager.department.id,
        departmentName: complianceManager.department.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  if (plan.complianceAssignment.action === "create") {
    items.push(
      conditionalPut({
        pk: `SITE#${plan.site.id}`,
        sk: `COMPLIANCE_MANAGER#${complianceManager.id}`,
        type: "siteComplianceManagerAssignment",
        entityType: "SITE_COMPLIANCE_MANAGER_ASSIGNMENT",
        siteId: plan.site.id,
        managerId: complianceManager.id,
        email: complianceManager.email,
        status: "active",
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      }),
    );
  }
  const providerManager = plan.providerManager;
  if (providerManager.action === "reuse") {
    items.push(
      activeMatch(
        {
          pk: `PROVIDER#${plan.provider.id}`,
          sk: `PROVIDER_MANAGER#${providerManager.id}`,
        },
        "email = :email",
        {},
        { ":email": providerManager.email },
      ),
    );
  } else {
    const membershipId = stableId(
      `${plan.provider.id}|${providerManager.email}|provider-manager`,
    );
    items.push(
      conditionalPut({
        pk: `PROVIDER#${plan.provider.id}`,
        sk: `PROVIDER_MANAGER#${providerManager.id}`,
        type: "providerManagerMembership",
        entityType: "PROVIDER_MANAGER_MEMBERSHIP",
        membershipId,
        managerId: providerManager.id,
        providerId: plan.provider.id,
        firstName: source["Provider manager first name"],
        lastName: source["Provider manager last name"],
        name: `${source["Provider manager first name"]} ${source["Provider manager last name"]}`.trim(),
        email: providerManager.email,
        phone: source["Provider manager phone"],
        phoneExtension: source["Provider manager extension"],
        status: "active",
        generation: 1,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      }),
      conditionalPut({
        pk: `PROVIDER_MANAGER_EMAIL#${stableId(providerManager.email)}`,
        sk: `PROVIDER#${plan.provider.id}#MEMBERSHIP#${membershipId}`,
        type: "providerManagerEmailDirectory",
        membershipId,
        managerId: providerManager.id,
        providerId: plan.provider.id,
        status: "active",
        createdAt: now,
      }),
    );
  }
  try {
    if (items.length) {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    }
    return recordOutcome(importId, row, "applied", "", {
      providerId: plan.provider.id,
      programId: plan.program.id,
      siteId: plan.site.id,
      userId: plan.contact.id,
      complianceManagerId: complianceManager.id,
      providerManagerId: providerManager.id,
    });
  } catch (error) {
    const failure = classifyApplyError(error);
    console.error("Site import row apply failed", {
      importId,
      rowNumber: row.rowNumber,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
      statusCode: applyErrorStatusCode(error),
      cancellationReasons: applyCancellationReasonCodes(error),
      reasonCode: failure.reasonCode,
      retryable: failure.retryable,
    });
    if (failure.reasonCode === "changed_after_preview") {
      return recordOutcome(
        importId,
        row,
        "skipped_conflict",
        failure.reasonCode,
      );
    }
    const attempts = Number(row.applyAttempts || 0);
    return recordOutcome(
      importId,
      row,
      failure.retryable && attempts < 2 ? "retryable_failed" : "failed",
      failure.reasonCode,
    );
  }
}

/** @param {unknown} error */
function classifyApplyError(error) {
  const name = error instanceof Error ? error.name : "";
  if (name === "TransactionCanceledException") {
    if (
      applyCancellationReasonCodes(error).some((code) =>
        [
          "ProvisionedThroughputExceeded",
          "ThrottlingError",
          "TransactionConflict",
        ].includes(code),
      )
    ) {
      return { reasonCode: "retryable_apply_error", retryable: true };
    }
    return { reasonCode: "changed_after_preview", retryable: false };
  }
  if (
    [
      "InternalServerError",
      "ProvisionedThroughputExceededException",
      "RequestLimitExceeded",
      "ServiceUnavailable",
      "ThrottlingException",
      "TransactionConflictException",
      "TransactionInProgressException",
    ].includes(name) ||
    applyErrorStatusCode(error) >= 500
  ) {
    return { reasonCode: "retryable_apply_error", retryable: true };
  }
  if (name === "ValidationException") {
    return { reasonCode: "invalid_apply_transaction", retryable: false };
  }
  if (["AccessDeniedException", "ResourceNotFoundException"].includes(name)) {
    return {
      reasonCode: "import_service_configuration_error",
      retryable: false,
    };
  }
  return { reasonCode: "unexpected_apply_error", retryable: false };
}

/** @param {unknown} error */
function applyErrorStatusCode(error) {
  if (!error || typeof error !== "object") return 0;
  const metadata = /** @type {{ $metadata?: { httpStatusCode?: unknown } }} */ (
    error
  ).$metadata;
  return Number(metadata?.httpStatusCode || 0);
}

/** @param {unknown} error */
function applyCancellationReasonCodes(error) {
  if (!error || typeof error !== "object") return [];
  const reasons = /** @type {{ CancellationReasons?: unknown }} */ (error)
    .CancellationReasons;
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((reason) =>
      reason && typeof reason === "object" && "Code" in reason
        ? String(reason.Code || "")
        : "",
    )
    .filter(Boolean);
}

/** @returns {Promise<Record<string, any>>} */
async function loadCatalog() {
  const tableName = getDynamoTableName();
  const [providers, programs, sites, complianceManagers, oversightOptions] =
    await Promise.all([
      ...[
        "PROVIDER_SEARCH#ACTIVE",
        "PROGRAM_SEARCH#ACTIVE",
        "SITE_SEARCH#ACTIVE",
      ].map((pk) =>
        queryAll({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
        }),
      ),
      queryAll({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
        },
      }),
      queryAll({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "ADMIN_DIRECTORY#OVERSIGHT" },
      }),
    ]);
  const siteIds = (sites.Items ?? []).map((item) => String(item.siteId));
  /** @type {any} */
  const siteItems = await batchGetSites(tableName, siteIds);
  const programItems = programs.Items ?? [];
  const users = await mapLimit(programItems, 10, (program) =>
    queryAll({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `PROGRAM#${program.programId}`,
        ":prefix": "USER#",
      },
    }),
  );
  const siteChildren = await mapLimit(siteIds, 10, (siteId) =>
    queryAll({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
      },
    }),
  );
  const providerChildren = await mapLimit(
    (providers.Items ?? []).map((item) => String(item.providerId)),
    10,
    (providerId) =>
      queryAll({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `PROVIDER#${providerId}` },
      }),
  );
  const children = siteChildren.flatMap((result) => result.Items ?? []);
  const providerItems = providerChildren.flatMap(
    (result) => result.Items ?? [],
  );
  return {
    providers: providers.Items ?? [],
    programs: programItems,
    sites: siteItems,
    users: users.flatMap((result) => result.Items ?? []),
    assignments: children.filter((item) =>
      String(item.sk || "").startsWith("ASSIGNED_USER#"),
    ),
    managerMemberships: children.filter((item) =>
      String(item.sk || "").startsWith("MANAGER_MEMBERSHIP#"),
    ),
    complianceManagers: complianceManagers.Items ?? [],
    complianceManagerAssignments: children.filter((item) =>
      String(item.sk || "").startsWith("COMPLIANCE_MANAGER#"),
    ),
    providerManagers: providerItems.filter((item) =>
      String(item.sk || "").startsWith("PROVIDER_MANAGER#"),
    ),
    departments: (oversightOptions.Items ?? []).filter(
      (item) => item.optionType === "department" && item.status !== "inactive",
    ),
  };
}

/** @param {Record<string, string>[]} rows @param {Record<string, any>} catalog */
function planRows(rows, catalog) {
  let providers = indexUnique(catalog.providers, (item) =>
    normalized(item.name),
  );
  let programs = indexUnique(
    catalog.programs,
    (item) => `${item.providerId}|${normalized(item.name)}`,
  );
  let sites = indexUnique(catalog.sites, (item) => siteIdentity(item));
  let users = indexUnique(
    catalog.users,
    (item) => `${item.programId}|${normalized(item.email)}`,
  );
  let assignments = indexUnique(
    catalog.assignments,
    (item) => `${item.siteId}|${item.userId}`,
  );
  const activeManagerMemberships = /** @type {any[]} */ (
    catalog.managerMemberships
  ).filter((item) => item.status === "active");
  let managersByUser = indexUnique(
    activeManagerMemberships,
    (item) => `${item.siteId}|${item.userId}`,
  );
  let managersByEmail = indexUnique(
    activeManagerMemberships,
    (item) => `${item.siteId}|${item.programId}|${normalized(item.email)}`,
  );
  let complianceManagers = indexUnique(catalog.complianceManagers, (item) =>
    normalized(item.email),
  );
  let complianceAssignments = indexUnique(
    catalog.complianceManagerAssignments,
    (item) => `${item.siteId}|${item.managerId}`,
  );
  let complianceManagerCounts = new Map();
  for (const assignment of catalog.complianceManagerAssignments) {
    const siteId = String(assignment.siteId || "");
    if (!siteId || assignment.status === "inactive") continue;
    const ids = complianceManagerCounts.get(siteId) || new Set();
    ids.add(String(assignment.managerId || ""));
    complianceManagerCounts.set(siteId, ids);
  }
  let providerManagers = indexUnique(
    catalog.providerManagers,
    (item) => `${item.providerId}|${normalized(item.email)}`,
  );
  const departments = departmentAliases(catalog.departments);
  let plannedDepartmentCreates = new Set();
  return rows.map((source, index) => {
    const previous = {
      providers,
      programs,
      sites,
      users,
      assignments,
      managersByUser,
      managersByEmail,
      complianceManagers,
      complianceAssignments,
      complianceManagerCounts,
      providerManagers,
      plannedDepartmentCreates,
    };
    providers = new Map(providers);
    programs = new Map(programs);
    sites = new Map(sites);
    users = new Map(users);
    assignments = new Map(assignments);
    managersByUser = new Map(managersByUser);
    managersByEmail = new Map(managersByEmail);
    complianceManagers = new Map(complianceManagers);
    complianceAssignments = new Map(complianceAssignments);
    complianceManagerCounts = new Map(
      [...complianceManagerCounts].map(([siteId, managerIds]) => [
        siteId,
        new Set(managerIds),
      ]),
    );
    providerManagers = new Map(providerManagers);
    plannedDepartmentCreates = new Set(plannedDepartmentCreates);
    const result = (() => {
      const rowNumber = index + 2;
      const missing = REQUIRED_HEADERS.filter(
        (header) => !clean(source[header]),
      );
      if (missing.length) {
        return {
          rowNumber,
          source,
          classification: "invalid",
          reasonCode: "missing_required_value",
          existingValue: missing.join(", "),
        };
      }
      const missingOptional = OPTIONAL_HEADERS.filter(
        (header) => !clean(source[header]),
      );
      const siteType = importedSiteType(source["Site type"]);
      if (!siteType) {
        return conflictRow(rowNumber, source, "invalid_site_type");
      }
      let department = importedDepartment(source.Department, departments);
      if (!department) {
        return conflictRow(
          rowNumber,
          source,
          "unknown_department",
          source.Department,
        );
      }
      let programManagerDepartment = importedDepartment(
        source["Program manager department"],
        departments,
      );
      if (!programManagerDepartment) {
        return conflictRow(
          rowNumber,
          source,
          "unknown_program_manager_department",
          source["Program manager department"],
        );
      }
      if (
        department.action === "create" &&
        plannedDepartmentCreates.has(department.id)
      ) {
        department = { ...department, action: "reuse" };
      }
      if (
        programManagerDepartment.action === "create" &&
        plannedDepartmentCreates.has(programManagerDepartment.id)
      ) {
        programManagerDepartment = {
          ...programManagerDepartment,
          action: "reuse",
        };
      }
      const providerKey = normalized(source.Provider);
      const providerExisting = providers.get(providerKey);
      if (Array.isArray(providerExisting)) {
        return conflictRow(rowNumber, source, "duplicate_existing_provider");
      }
      const providerId = providerExisting?.providerId || slug(source.Provider);
      const provider = {
        id: providerId,
        action: providerExisting ? "reuse" : "create",
        name: providerExisting?.name || source.Provider,
      };
      if (!providerExisting)
        providers.set(providerKey, { providerId, name: source.Provider });
      const programKey = `${providerId}|${normalized(source.Program)}`;
      const programExisting = programs.get(programKey);
      if (Array.isArray(programExisting)) {
        return conflictRow(rowNumber, source, "duplicate_existing_program");
      }
      const programId =
        programExisting?.programId || slug(`${providerId}-${source.Program}`);
      const program = {
        id: programId,
        action: programExisting ? "reuse" : "create",
        name: programExisting?.name || source.Program,
      };
      if (!programExisting)
        programs.set(programKey, {
          programId,
          providerId,
          name: source.Program,
        });
      const siteKey = siteIdentity({
        name: source["Site name"],
        address: source["Site address"],
      });
      const siteExisting = sites.get(siteKey);
      if (Array.isArray(siteExisting)) {
        return conflictRow(rowNumber, source, "duplicate_existing_site");
      }
      if (
        siteExisting &&
        (siteExisting.providerId !== providerId ||
          siteExisting.leadProgramId !== programId ||
          siteIdentity(siteExisting) !== siteKey ||
          (siteExisting.siteType && siteExisting.siteType !== siteType) ||
          (siteExisting.oversight?.managingCityDepartment &&
            normalized(siteExisting.oversight.managingCityDepartment) !==
              normalized(department.name)))
      ) {
        return conflictRow(
          rowNumber,
          source,
          "site_exact_match_conflict",
          `${siteExisting.name} — ${siteExisting.address || "address unavailable"}`,
        );
      }
      const siteId =
        siteExisting?.siteId ||
        slug(`${source["Site name"]}-${source["Site address"]}`);
      const site = {
        id: siteId,
        action: siteExisting ? "reuse" : "create",
        name: siteExisting?.name || source["Site name"],
        address: siteExisting?.address || source["Site address"],
        siteType,
        department,
        expectedOversight: siteExisting?.oversight || null,
        oversight: {
          ...(siteExisting?.oversight || {}),
          managingCityDepartment: department.name,
        },
      };
      if (!siteExisting)
        sites.set(siteKey, {
          siteId,
          providerId,
          leadProgramId: programId,
          name: source["Site name"],
          address: source["Site address"],
          siteType,
          oversight: { managingCityDepartment: department.name },
        });
      const contactKey = `${programId}|${normalized(source["Site manager email"])}`;
      const contactExisting = users.get(contactKey);
      if (Array.isArray(contactExisting)) {
        return conflictRow(rowNumber, source, "duplicate_existing_contact");
      }
      if (contactExisting && !sameContact(contactExisting, source)) {
        return conflictRow(
          rowNumber,
          source,
          "contact_exact_match_conflict",
          String(contactExisting.email),
        );
      }
      const contactId = contactExisting?.userId || stableId(contactKey);
      const contact = {
        id: contactId,
        action: contactExisting ? "reuse" : "create",
        email: normalized(
          contactExisting?.email || source["Site manager email"],
        ),
        promote: Boolean(
          contactExisting && contactExisting.siteManager !== true,
        ),
      };
      if (!contactExisting)
        users.set(contactKey, {
          userId: contactId,
          programId,
          firstName: source["Site manager first name"],
          lastName: source["Site manager last name"],
          phone: source["Site manager phone"],
          phoneExtension: source["Site manager extension"],
          email: source["Site manager email"],
        });
      const assignmentKey = `${siteId}|${contactId}`;
      const assignmentExisting = assignments.get(assignmentKey);
      if (Array.isArray(assignmentExisting)) {
        return conflictRow(rowNumber, source, "duplicate_existing_assignment");
      }
      const assignment = {
        action: assignmentExisting ? "reuse" : "create",
      };
      if (!assignmentExisting) {
        assignments.set(assignmentKey, { siteId, userId: contactId });
      }
      const managerKey = `${siteId}|${contactId}`;
      const managerEmailKey = `${siteId}|${programId}|${contact.email}`;
      const managerExisting =
        managersByUser.get(managerKey) || managersByEmail.get(managerEmailKey);
      if (Array.isArray(managerExisting)) {
        return conflictRow(rowNumber, source, "duplicate_existing_manager");
      }
      const manager = {
        id: managerExisting?.membershipId || randomUUID(),
        action: managerExisting ? "reuse" : "create",
      };
      if (!managerExisting) {
        const plannedManager = {
          membershipId: manager.id,
          siteId,
          programId,
          userId: contactId,
          email: contact.email,
        };
        managersByUser.set(managerKey, plannedManager);
        managersByEmail.set(managerEmailKey, plannedManager);
      }
      const complianceEmail = normalized(source["Program manager email"]);
      const complianceExisting = complianceManagers.get(complianceEmail);
      if (Array.isArray(complianceExisting)) {
        return conflictRow(
          rowNumber,
          source,
          "duplicate_existing_program_manager",
        );
      }
      if (
        complianceExisting &&
        !sameImportedPerson(complianceExisting, source, "Program manager")
      ) {
        return conflictRow(
          rowNumber,
          source,
          "program_manager_exact_match_conflict",
          complianceEmail,
        );
      }
      if (complianceExisting?.status === "inactive") {
        return conflictRow(
          rowNumber,
          source,
          "inactive_program_manager",
          complianceEmail,
        );
      }
      if (
        complianceExisting?.departmentId &&
        complianceExisting.departmentId !== programManagerDepartment.id
      ) {
        return conflictRow(
          rowNumber,
          source,
          "program_manager_department_conflict",
          String(complianceExisting.departmentName || ""),
        );
      }
      const complianceManager = {
        id: complianceExisting?.userId || stableId(complianceEmail),
        action: complianceExisting ? "reuse" : "create",
        email: complianceEmail,
        department: programManagerDepartment,
      };
      if (!complianceExisting) {
        complianceManagers.set(complianceEmail, {
          userId: complianceManager.id,
          email: complianceEmail,
          firstName: source["Program manager first name"],
          lastName: source["Program manager last name"],
          phone: source["Program manager phone"],
          phoneExtension: source["Program manager extension"],
          departmentId: programManagerDepartment.id,
          departmentName: programManagerDepartment.name,
        });
      }
      const complianceAssignmentKey = `${siteId}|${complianceManager.id}`;
      const complianceAssignmentExisting = complianceAssignments.get(
        complianceAssignmentKey,
      );
      if (Array.isArray(complianceAssignmentExisting)) {
        return conflictRow(
          rowNumber,
          source,
          "duplicate_existing_program_manager_assignment",
        );
      }
      if (complianceAssignmentExisting?.status === "inactive") {
        return conflictRow(
          rowNumber,
          source,
          "inactive_program_manager_assignment",
          complianceEmail,
        );
      }
      const complianceAssignment = {
        action: complianceAssignmentExisting ? "reuse" : "create",
      };
      if (!complianceAssignmentExisting) {
        const assignedIds = complianceManagerCounts.get(siteId) || new Set();
        if (assignedIds.size >= 2) {
          return conflictRow(rowNumber, source, "too_many_program_managers");
        }
        complianceAssignments.set(complianceAssignmentKey, {
          siteId,
          managerId: complianceManager.id,
        });
        assignedIds.add(complianceManager.id);
        complianceManagerCounts.set(siteId, assignedIds);
      }
      const providerManagerEmail = normalized(source["Provider manager email"]);
      const providerManagerKey = `${providerId}|${providerManagerEmail}`;
      const providerManagerExisting = providerManagers.get(providerManagerKey);
      if (Array.isArray(providerManagerExisting)) {
        return conflictRow(
          rowNumber,
          source,
          "duplicate_existing_provider_manager",
        );
      }
      if (
        providerManagerExisting &&
        !sameImportedPerson(providerManagerExisting, source, "Provider manager")
      ) {
        return conflictRow(
          rowNumber,
          source,
          "provider_manager_exact_match_conflict",
          providerManagerEmail,
        );
      }
      if (providerManagerExisting?.status === "inactive") {
        return conflictRow(
          rowNumber,
          source,
          "inactive_provider_manager",
          providerManagerEmail,
        );
      }
      const providerManager = {
        id:
          providerManagerExisting?.managerId || stableId(providerManagerEmail),
        action: providerManagerExisting ? "reuse" : "create",
        email: providerManagerEmail,
      };
      if (!providerManagerExisting) {
        providerManagers.set(providerManagerKey, {
          providerId,
          managerId: providerManager.id,
          email: providerManagerEmail,
          firstName: source["Provider manager first name"],
          lastName: source["Provider manager last name"],
          phone: source["Provider manager phone"],
          phoneExtension: source["Provider manager extension"],
        });
      }
      if (department.action === "create") {
        plannedDepartmentCreates.add(department.id);
      }
      if (programManagerDepartment.action === "create") {
        plannedDepartmentCreates.add(programManagerDepartment.id);
      }
      const actions = [
        provider,
        program,
        site,
        contact,
        assignment,
        manager,
        complianceManager,
        complianceAssignment,
        providerManager,
        department,
        programManagerDepartment,
      ];
      return {
        rowNumber,
        source,
        classification: missingOptional.length
          ? "acceptable"
          : actions.some((item) => item.action === "create")
            ? "create"
            : "reuse",
        reasonCode: missingOptional.length ? "missing_optional_value" : "",
        existingValue: missingOptional.join(", "),
        plan: {
          provider,
          program,
          site,
          contact,
          assignment,
          manager,
          complianceManager,
          complianceAssignment,
          providerManager,
          departments: [department, programManagerDepartment],
        },
      };
    })();
    if (!result.plan) {
      ({
        providers,
        programs,
        sites,
        users,
        assignments,
        managersByUser,
        managersByEmail,
        complianceManagers,
        complianceAssignments,
        complianceManagerCounts,
        providerManagers,
        plannedDepartmentCreates,
      } = previous);
    }
    return result;
  });
}

/** @param {string} importId @param {Record<string, unknown>} row @param {string} outcome @param {string} reasonCode @param {Record<string, string>} [ids] */
function recordOutcome(importId, row, outcome, reasonCode, ids = {}) {
  return ddb.send(
    new UpdateCommand({
      TableName: getDynamoTableName(),
      Key: { pk: `SITE_IMPORT#${importId}`, sk: String(row.sk) },
      UpdateExpression:
        "SET outcome = :outcome, reasonCode = :reason, resultIds = :ids, appliedAt = :now ADD applyAttempts :one",
      ExpressionAttributeValues: {
        ":outcome": outcome,
        ":reason": reasonCode,
        ":ids": ids,
        ":now": new Date().toISOString(),
        ":one": 1,
      },
    }),
  );
}

/** @param {string} importId */
function queryImportRows(importId) {
  return queryAll({
    TableName: getDynamoTableName(),
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": `SITE_IMPORT#${importId}`,
      ":prefix": "ROW#",
    },
  });
}

/**
 * Read every DynamoDB Query page. Import correctness depends on a complete
 * catalog/ledger; silently accepting the first 1 MiB page can misclassify or
 * skip rows.
 * @param {import("@aws-sdk/lib-dynamodb").QueryCommandInput} input
 * @returns {Promise<{Items: Record<string, any>[]} >}
 */
async function queryAll(input) {
  const Items = [];
  let ExclusiveStartKey;
  do {
    /** @type {any} */
    const result = await ddb.send(
      new QueryCommand({
        ...input,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    Items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { Items };
}

/** @param {Record<string, unknown>[]} items */
async function batchPut(items) {
  const tableName = getDynamoTableName();
  for (let offset = 0; offset < items.length; offset += 25) {
    /** @type {any[]} */
    let pending = items
      .slice(offset, offset + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length && attempt < 4; attempt += 1) {
      const result = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      pending = result.UnprocessedItems?.[tableName] ?? [];
    }
    if (pending.length) throw new Error("import_ledger_write_incomplete");
  }
}

/** @param {string} tableName @param {string[]} siteIds */
async function batchGetSites(tableName, siteIds) {
  const items = [];
  for (let offset = 0; offset < siteIds.length; offset += 100) {
    /** @type {any[]} */
    let keys = siteIds.slice(offset, offset + 100).map((siteId) => ({
      pk: `SITE#${siteId}`,
      sk: "#META",
    }));
    for (let attempt = 0; keys.length && attempt < 4; attempt += 1) {
      const result = await ddb.send(
        new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys } } }),
      );
      items.push(...(result.Responses?.[tableName] ?? []));
      keys = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }
    if (keys.length) throw new Error("import_catalog_read_incomplete");
  }
  return items;
}

/** @param {any[]} items @param {number} limit @param {(item: any) => Promise<any>} work */
async function mapLimit(items, limit, work) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += limit) {
    results.push(
      ...(await Promise.all(items.slice(offset, offset + limit).map(work))),
    );
  }
  return results;
}

/** @param {Record<string, unknown>} Item */
function conditionalPut(Item) {
  return {
    Put: {
      TableName: getDynamoTableName(),
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}

/**
 * @param {{ pk: string, sk: string }} Key
 * @param {string} expression
 * @param {Record<string, string>} names
 * @param {Record<string, unknown>} values
 */
function activeMatch(Key, expression, names, values) {
  return {
    ConditionCheck: {
      TableName: getDynamoTableName(),
      Key,
      ConditionExpression: `attribute_exists(pk) AND #status = :active AND ${expression}`,
      ExpressionAttributeNames: { "#status": "status", ...names },
      ExpressionAttributeValues: { ":active": "active", ...values },
    },
  };
}

/** @param {string} csv */
function parseCsv(csv) {
  /** @type {string[][]} */
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("unterminated_quote");
  record.push(field);
  if (record.some((value) => value !== "")) records.push(record);
  const headers = records.shift() ?? [];
  if (new Set(headers).size !== headers.length)
    throw new Error("duplicate_headers");
  const rows = records.map((values) => {
    if (values.length !== headers.length) throw new Error("invalid_columns");
    return Object.fromEntries(
      headers.map((header, index) => [header, clean(values[index])]),
    );
  });
  return { headers, rows };
}

/** @param {any[]} rows */
function countClassifications(rows) {
  return rows.reduce(
    (counts, row) => ({
      ...counts,
      [row.classification]: (counts[row.classification] || 0) + 1,
    }),
    { create: 0, reuse: 0, acceptable: 0, conflict: 0, invalid: 0 },
  );
}

/** @param {any[]} rows */
function countOutcomes(rows) {
  return rows.reduce(
    (counts, row) => ({
      ...counts,
      [row.outcome || (isApplicable(row) ? "pending" : "skipped")]:
        (counts[row.outcome || (isApplicable(row) ? "pending" : "skipped")] ||
          0) + 1,
    }),
    { applied: 0, skipped: 0, skipped_conflict: 0, failed: 0, pending: 0 },
  );
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
function requesterId(event) {
  return String(
    /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
      "central-admin",
  );
}

/** @param {Record<string, any>} row */
function publicRow(row) {
  return {
    rowNumber: row.rowNumber,
    source: row.source,
    classification: row.classification,
    reasonCode: row.reasonCode || "",
    existingValue: row.existingValue || "",
    outcome: row.outcome || "",
    resultIds: row.resultIds || {},
  };
}

/** @param {Record<string, any>} row */
function isApplicable(row) {
  return ["create", "reuse", "acceptable"].includes(row.classification);
}

/** @param {Record<string, any>} row */
function isTerminal(row) {
  return ["applied", "skipped_conflict", "failed"].includes(row.outcome);
}

/** @param {any[]} items @param {(item: any) => string} key */
function indexUnique(items, key) {
  const index = new Map();
  for (const item of items) {
    const value = key(item);
    const current = index.get(value);
    index.set(
      value,
      current
        ? Array.isArray(current)
          ? [...current, item]
          : [current, item]
        : item,
    );
  }
  return index;
}

/** @param {Record<string, any>} item @param {Record<string, string>} source */
function sameContact(item, source) {
  return (
    normalized(item.firstName) ===
      normalized(source["Site manager first name"]) &&
    normalized(item.lastName) ===
      normalized(source["Site manager last name"]) &&
    (!clean(source["Site manager phone"]) ||
      normalized(item.phone) === normalized(source["Site manager phone"])) &&
    (!clean(source["Site manager extension"]) ||
      normalized(item.phoneExtension) ===
        normalized(source["Site manager extension"])) &&
    normalized(item.email) === normalized(source["Site manager email"])
  );
}

/** @param {Record<string, any>} item @param {Record<string, string>} source @param {"Program manager" | "Provider manager"} prefix */
function sameImportedPerson(item, source, prefix) {
  return (
    normalized(item.firstName) === normalized(source[`${prefix} first name`]) &&
    normalized(item.lastName) === normalized(source[`${prefix} last name`]) &&
    normalized(item.email) === normalized(source[`${prefix} email`]) &&
    (!clean(source[`${prefix} phone`]) ||
      normalized(item.phone) === normalized(source[`${prefix} phone`])) &&
    (!clean(source[`${prefix} extension`]) ||
      normalized(item.phoneExtension) ===
        normalized(source[`${prefix} extension`]))
  );
}

/** @param {unknown} value */
function importedSiteType(value) {
  return new Map([
    ["permanent supportive housing", "permanent_supportive_housing"],
    ["drop-in", "drop_in"],
    ["drop in", "drop_in"],
    ["shelter", "shelter"],
  ]).get(normalized(value));
}

/** @param {Record<string, any>[]} items */
function departmentAliases(items) {
  const aliases = new Map();
  const configured = items.map((item) => ({
    id: String(item.departmentId || item.sk || "")
      .replace(/^DEPARTMENT#/, "")
      .toLocaleLowerCase("en-US"),
    name: String(item.name || ""),
    action: "reuse",
  }));
  for (const item of configured) aliases.set(normalized(item.name), item);
  const known = [
    {
      id: "dph",
      name: "Department of Public Health (DPH)",
      aliases: [
        "dph",
        "department of public health",
        "department of public health (dph)",
      ],
    },
    {
      id: "hsh",
      name: "Homelessness and Supportive Housing (HSH)",
      aliases: [
        "hsh",
        "homelessness and supportive housing",
        "homelessness and supportive housing (hsh)",
      ],
    },
  ];
  for (const canonical of known) {
    const existing = canonical.aliases
      .map((alias) => aliases.get(alias))
      .find(Boolean);
    const value = existing || {
      id: canonical.id,
      name: canonical.name,
      action: "create",
    };
    for (const alias of canonical.aliases) aliases.set(alias, value);
  }
  return aliases;
}

/** @param {unknown} value @param {Map<string, Record<string, any>>} aliases */
function importedDepartment(value, aliases) {
  return aliases.get(normalized(value)) || null;
}

/** @param {any[]} items @param {(item: any) => string} key */
function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

/** @param {number} rowNumber @param {Record<string, string>} source @param {string} reasonCode @param {string} [existingValue] */
function conflictRow(rowNumber, source, reasonCode, existingValue = "") {
  return {
    rowNumber,
    source,
    classification: "conflict",
    reasonCode,
    existingValue,
  };
}

/** @param {unknown} value */
function clean(value) {
  return String(value ?? "").trim();
}
/** @param {unknown} value */
function normalized(value) {
  return clean(value).toLocaleLowerCase("en-US");
}

/**
 * @param {{name?: unknown, siteName?: unknown, address?: unknown}} site
 * @returns {string}
 */
function siteIdentity(site) {
  return `${normalized(site.name ?? site.siteName)}|${normalized(site.address)}`;
}
/** @param {string} value */
function slug(value) {
  return (
    normalized(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || stableId(value)
  );
}
/** @param {string} value */
function stableId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
/** @param {string[]} actual @param {string[]} expected */
function sameHeaders(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
/** @param {unknown} value */
function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
/** @param {string} reason */
function guidance(reason) {
  return reason === "missing_required_value"
    ? "Complete every required column and upload again."
    : reason === "changed_after_preview"
      ? "Download current data, correct the source row, and preview again."
      : reason === "retryable_apply_error"
        ? "Retry the apply operation. If it fails again, contact an administrator."
        : [
              "invalid_apply_transaction",
              "import_service_configuration_error",
              "unexpected_apply_error",
            ].includes(reason)
          ? "Contact an administrator. The source row does not need correction."
          : "Compare the supplied and existing values, correct the source CSV, and preview again.";
}
