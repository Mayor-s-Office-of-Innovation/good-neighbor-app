import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import {
  ADMIN_GROUPS,
  adminOnly,
  adminPrincipal,
  siteAdminOnly,
  supervisorOnly,
} from "../lib/admin-auth.js";

/** Replace the Compliance managers assigned to one Site. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const replaceSiteComplianceManagers = (event) =>
  supervisorOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const managerIds = [
      ...new Set(
        (Array.isArray(body.managerIds) ? body.managerIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    ];
    if (managerIds.length > 2) {
      return jsonResponse(400, { error: "too_many_compliance_managers" });
    }
    const tableName = getDynamoTableName();
    const [siteResult, managersResult, siteItemsResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: {
            ":pk": "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
          },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `SITE#${siteId}`,
            ":prefix": "COMPLIANCE_MANAGER#",
          },
        }),
      ),
    ]);
    if (!siteResult.Item || siteResult.Item.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const managers = (managersResult.Items ?? []).filter(
      (item) => item.status !== "inactive",
    );
    const managersById = new Map(
      managers.map((manager) => [String(manager.userId), manager]),
    );
    if (managerIds.some((managerId) => !managersById.has(managerId))) {
      return jsonResponse(400, { error: "invalid_compliance_manager" });
    }
    const current = siteItemsResult.Items ?? [];
    const currentIds = new Set(
      current.map((assignment) => String(assignment.managerId)),
    );
    const nextIds = new Set(managerIds);
    const now = new Date().toISOString();
    const actor = adminPrincipal(event).subject || "central-admin";
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [];
    for (const managerId of managerIds) {
      if (currentIds.has(managerId)) continue;
      const manager = managersById.get(managerId);
      items.push(
        put({
          pk: `SITE#${siteId}`,
          sk: `COMPLIANCE_MANAGER#${managerId}`,
          type: "siteComplianceManagerAssignment",
          entityType: "SITE_COMPLIANCE_MANAGER_ASSIGNMENT",
          siteId,
          managerId,
          email: String(manager?.email || ""),
          status: "active",
          createdAt: now,
          createdBy: actor,
          updatedAt: now,
          updatedBy: actor,
        }),
      );
    }
    for (const assignment of current) {
      if (nextIds.has(String(assignment.managerId))) continue;
      items.push({
        Delete: {
          TableName: tableName,
          Key: { pk: assignment.pk, sk: assignment.sk },
          ConditionExpression: "attribute_exists(pk)",
        },
      });
    }
    if (items.length) {
      items.push(
        put({
          pk: `SITE#${siteId}`,
          sk: `AUDIT#${now}#${randomUUID()}`,
          type: "siteAuditEvent",
          eventType: "site_compliance_managers_replaced",
          siteId,
          managerIds,
          actor,
          createdAt: now,
        }),
      );
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    }
    return jsonResponse(200, {
      assignments: managerIds.map((managerId) => ({
        siteId,
        managerId,
        manager: managersById.get(managerId),
      })),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listSiteTerms = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "COMPLIANCE_TERMS#",
        },
        ScanIndexForward: false,
      }),
    );
    return jsonResponse(200, { terms: result.Items ?? [] });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createSiteTerms = (event) =>
  siteAdminOnly(event, event.pathParameters?.siteId ?? "", async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const reasons = normalizeReasons(body.reasons);
    const tier =
      body.correctiveActionTier === undefined
        ? null
        : Number(body.correctiveActionTier);
    const requiredChecksPerDay = Number(body.requiredChecksPerDay);
    const siteManagerUserId = String(body.siteManagerUserId || "").trim();
    // Periods always begin when they are saved. Keep the effective date
    // server-owned so API callers cannot create unsupported scheduled terms.
    const effectiveStart = pacificIsoDate();
    const periodEnd = body.periodEnd ? isoDate(body.periodEnd) : "";
    const expiresOnExclusive = periodEnd ? nextIsoDate(periodEnd) : "";
    if (!reasons.length)
      return jsonResponse(400, { error: "reasons_required" });
    if (!siteManagerUserId) {
      return jsonResponse(400, { error: "site_manager_required" });
    }
    if (
      reasons.includes("6") &&
      (!Number.isInteger(tier) || Number(tier) < 1 || Number(tier) > 4)
    ) {
      return jsonResponse(400, { error: "invalid_tier" });
    }
    if (!reasons.includes("6") && tier !== null) {
      return jsonResponse(400, { error: "tier_requires_reason_six" });
    }
    if (!Number.isInteger(requiredChecksPerDay) || requiredChecksPerDay < 1) {
      return jsonResponse(400, { error: "invalid_check_cadence" });
    }
    if (body.periodEnd && !periodEnd) {
      return jsonResponse(400, { error: "invalid_expiry" });
    }
    if (
      reasons.some((reason) => ["1", "5", "6"].includes(reason)) &&
      !periodEnd
    ) {
      return jsonResponse(400, { error: "expiry_required" });
    }
    if (expiresOnExclusive && expiresOnExclusive <= effectiveStart) {
      return jsonResponse(400, { error: "invalid_terms_range" });
    }
    const tableName = getDynamoTableName();
    const [siteResult, termsResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `SITE#${siteId}`,
            ":prefix": "COMPLIANCE_TERMS#",
          },
        }),
      ),
    ]);
    if (!siteResult.Item || siteResult.Item.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const site = siteResult.Item;
    const oversight = site.oversight;
    if (!site.name || !site.address || !oversight?.managingCityDepartment) {
      return jsonResponse(409, { error: "letter_details_required" });
    }
    const [siteManagerAssignment, siteManagerResult, generatorResult] =
      await Promise.all([
        ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: `SITE#${siteId}`,
              sk: `ASSIGNED_USER#${siteManagerUserId}`,
            },
          }),
        ),
        ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: `PROGRAM#${site.leadProgramId}`,
              sk: `USER#${siteManagerUserId}`,
            },
          }),
        ),
        resolveLetterGenerator(event, siteId, tableName),
      ]);
    const siteManager = siteManagerResult.Item;
    if (
      !siteManagerAssignment.Item ||
      siteManagerAssignment.Item.status === "inactive" ||
      !siteManager ||
      siteManager.status === "inactive" ||
      !siteManager.firstName ||
      !siteManager.lastName
    ) {
      return jsonResponse(409, { error: "site_manager_required" });
    }
    if (generatorResult.error) {
      return jsonResponse(generatorResult.status, {
        error: generatorResult.error,
      });
    }
    const generator = generatorResult.manager;
    if (
      !generator?.firstName ||
      !generator?.lastName ||
      !generator?.email ||
      !generator?.phone
    ) {
      return jsonResponse(409, { error: "generator_contact_required" });
    }
    const programManager = generator;
    /* The authenticated generator is snapshotted onto the immutable terms.
     * The client cannot nominate another sender. */
    const generatorDepartment =
      generator.departmentName || oversight.managingCityDepartment;
    if (!generatorDepartment) {
      return jsonResponse(409, { error: "generator_department_required" });
    }
    /* Preserve a strongly typed assignment check for the selected Site
     * manager independently of the letter sender. */
    if (siteManagerAssignment.Item.programId !== site.leadProgramId) {
      return jsonResponse(409, { error: "site_manager_required" });
    }
    const existing = (termsResult.Items ?? []).filter(
      (item) => item.status !== "cancelled",
    );
    if (
      existing.some(
        (item) =>
          item.effectiveStart === effectiveStart &&
          (!item.expiresOnExclusive ||
            String(item.expiresOnExclusive) > effectiveStart),
      )
    ) {
      return jsonResponse(409, { error: "terms_start_conflict" });
    }
    const futureCollision = existing.some(
      (item) =>
        String(item.effectiveStart) > effectiveStart &&
        (!expiresOnExclusive ||
          String(item.effectiveStart) < expiresOnExclusive),
    );
    if (futureCollision) {
      return jsonResponse(409, { error: "terms_overlap" });
    }
    const prior = existing
      .filter(
        (item) =>
          String(item.effectiveStart) < effectiveStart &&
          (!item.expiresOnExclusive ||
            String(item.expiresOnExclusive) > effectiveStart),
      )
      .sort((a, b) =>
        String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
      )[0];
    const now = new Date().toISOString();
    const termsVersionId = randomUUID();
    const observedLatestVersion =
      siteResult.Item.latestComplianceTermsVersionId;
    const actor = adminPrincipal(event).subject || "central-admin";
    const terms = {
      pk: `SITE#${siteId}`,
      sk: `COMPLIANCE_TERMS#${effectiveStart}#${termsVersionId}`,
      type: "complianceTerms",
      entityType: "COMPLIANCE_TERMS",
      siteId,
      termsVersionId,
      reasons,
      ...(tier === null ? {} : { correctiveActionTier: tier }),
      requiredChecksPerDay,
      effectiveStart,
      ...(periodEnd ? { periodEnd } : {}),
      ...(expiresOnExclusive ? { expiresOnExclusive } : {}),
      status: termsStatus(effectiveStart, expiresOnExclusive),
      createdAt: now,
      createdBy: actor,
      letterInputs: {
        confirmedOn: effectiveStart,
        siteName: String(site.name),
        siteManagerId: siteManagerUserId,
        siteManagerFirstName: String(siteManager.firstName),
        siteManagerName:
          `${siteManager.firstName} ${siteManager.lastName}`.trim(),
        siteAddress: String(site.address),
        departmentName: String(generatorDepartment),
        generatedByRole: adminPrincipal(event).role,
        programManagerName:
          `${programManager.firstName} ${programManager.lastName}`.trim(),
        programManagerPhone: String(programManager.phone),
        programManagerExtension: String(programManager.phoneExtension || ""),
        programManagerEmail: String(programManager.email),
      },
    };
    const letterJobId = randomUUID();
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const transaction = [
      put(terms),
      {
        Update: {
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          UpdateExpression:
            "SET latestComplianceTermsVersionId = :version, complianceTermsUpdatedAt = :now, letterState = :dirty, compliance = :compliance, updatedAt = :now",
          ConditionExpression:
            observedLatestVersion === undefined
              ? "attribute_exists(pk) AND attribute_not_exists(latestComplianceTermsVersionId)"
              : "attribute_exists(pk) AND latestComplianceTermsVersionId = :observedLatest",
          ExpressionAttributeValues: {
            ":version": termsVersionId,
            ":now": now,
            ":dirty": "draft_pending",
            ":compliance": {
              perimeterChecksRequired: true,
              periodStart: effectiveStart,
              ...(periodEnd ? { periodEnd } : {}),
              requiredChecksPerDay,
              ...(tier === null ? {} : { currentTier: tier }),
            },
            ...(observedLatestVersion === undefined
              ? {}
              : { ":observedLatest": observedLatestVersion }),
          },
        },
      },
      put({
        pk: `SITE#${siteId}`,
        sk: `LETTER_JOB#${now}#${letterJobId}`,
        type: "complianceLetterGenerationJob",
        entityType: "COMPLIANCE_LETTER_OUTBOX",
        siteId,
        letterJobId,
        termsVersionId,
        termsSk: terms.sk,
        status: "pending",
        createdAt: now,
        createdBy: actor,
      }),
      put({
        pk: `SITE#${siteId}`,
        sk: `AUDIT#${now}#${termsVersionId}`,
        type: "siteAuditEvent",
        eventType: "compliance_terms_created",
        siteId,
        termsVersionId,
        actor,
        createdAt: now,
      }),
    ];
    if (prior) {
      transaction.push({
        Update: {
          TableName: tableName,
          Key: { pk: String(prior.pk), sk: String(prior.sk) },
          UpdateExpression:
            "SET expiresOnExclusive = :expiry, updatedAt = :now",
          ConditionExpression:
            "attribute_not_exists(expiresOnExclusive) OR expiresOnExclusive > :expiry",
          ExpressionAttributeValues: { ":expiry": effectiveStart, ":now": now },
        },
      });
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: transaction }));
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "terms_write_conflict" });
      }
      throw error;
    }
    return jsonResponse(201, { terms, letterState: "draft_pending" });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const endSiteTerms = (event) =>
  siteAdminOnly(event, event.pathParameters?.siteId ?? "", async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const tableName = getDynamoTableName();
    const [siteResult, termsResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `SITE#${siteId}`,
            ":prefix": "COMPLIANCE_TERMS#",
          },
          ConsistentRead: true,
        }),
      ),
    ]);
    if (!siteResult.Item || siteResult.Item.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const today = pacificIsoDate();
    const active = (termsResult.Items ?? [])
      .filter(
        (item) =>
          item.status !== "cancelled" &&
          item.effectiveStart <= today &&
          (!item.expiresOnExclusive || item.expiresOnExclusive > today),
      )
      .sort((a, b) =>
        String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
      )[0];
    if (!active) return jsonResponse(409, { error: "no_active_checks_period" });
    const now = new Date().toISOString();
    const actor = String(
      /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
        "central-admin",
    );
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk: active.pk, sk: active.sk },
                UpdateExpression:
                  "SET expiresOnExclusive = :today, endedOn = :today, endedAt = :now, endedBy = :actor, #status = :ended",
                ConditionExpression:
                  "attribute_not_exists(expiresOnExclusive) OR expiresOnExclusive > :today",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":today": today,
                  ":now": now,
                  ":actor": actor,
                  ":ended": "expired",
                },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { pk: `SITE#${siteId}`, sk: "#META" },
                UpdateExpression:
                  "SET compliance = :compliance, complianceTermsUpdatedAt = :now, updatedAt = :now",
                ConditionExpression:
                  "latestComplianceTermsVersionId = :version",
                ExpressionAttributeValues: {
                  ":compliance": { perimeterChecksRequired: false },
                  ":now": now,
                  ":version": active.termsVersionId,
                },
              },
            },
            put({
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "perimeter_checks_period_ended",
              siteId,
              termsVersionId: active.termsVersionId,
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "terms_close_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      termsVersionId: active.termsVersionId,
      endedAt: now,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const assignSiteUser = (event) =>
  supervisorOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const userId = clean(body.userId);
    if (!userId) return jsonResponse(400, { error: "user_required" });
    const tableName = getDynamoTableName();
    const siteResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = siteResult.Item;
    if (!site || site.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    if (!site.leadProgramId) {
      return jsonResponse(409, { error: "site_program_required" });
    }
    const [userResult, assignmentResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            pk: `PROGRAM#${site.leadProgramId}`,
            sk: `USER#${userId}`,
          },
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
        }),
      ),
    ]);
    const user = userResult.Item;
    if (!user || user.status === "inactive") {
      return jsonResponse(404, { error: "program_user_not_found" });
    }
    const primary = body.primary === true || !site.primaryContactUserId;
    const now = new Date().toISOString();
    if (assignmentResult.Item) {
      if (!primary) {
        return jsonResponse(200, { assignment: assignmentResult.Item });
      }
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [primaryContactUpdate(tableName, siteId, user, now)],
        }),
      );
      return jsonResponse(200, {
        assignment: assignmentResult.Item,
        primaryContactUserId: userId,
      });
    }
    const assignment = {
      pk: `SITE#${siteId}`,
      sk: `ASSIGNED_USER#${userId}`,
      type: "siteUserAssignment",
      siteId,
      programId: site.leadProgramId,
      userId,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [
      put(assignment),
      {
        Update: {
          TableName: tableName,
          Key: {
            pk: `PROGRAM#${site.leadProgramId}`,
            sk: `USER#${userId}`,
          },
          UpdateExpression: "ADD siteAssignmentCount :one SET updatedAt = :now",
          ConditionExpression: "attribute_exists(pk) AND #status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":now": now,
            ":active": "active",
          },
        },
      },
    ];
    if (primary) items.push(primaryContactUpdate(tableName, siteId, user, now));
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "site_user_assignment_conflict" });
      }
      throw error;
    }
    return jsonResponse(201, {
      assignment,
      ...(primary ? { primaryContactUserId: userId } : {}),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const unassignSiteUser = (event) =>
  supervisorOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const userId = event.pathParameters?.userId ?? "";
    const tableName = getDynamoTableName();
    const [siteResult, assignmentResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
        }),
      ),
    ]);
    const site = siteResult.Item;
    const assignment = assignmentResult.Item;
    if (!site || !assignment) return jsonResponse(404, { error: "not_found" });
    if (site.primaryContactUserId === userId) {
      return jsonResponse(409, {
        error: "primary_contact_replacement_required",
      });
    }
    const now = new Date().toISOString();
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName,
                Key: {
                  pk: `SITE#${siteId}`,
                  sk: `ASSIGNED_USER#${userId}`,
                },
                ConditionExpression: "attribute_exists(pk)",
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: {
                  pk: `PROGRAM#${assignment.programId}`,
                  sk: `USER#${userId}`,
                },
                UpdateExpression:
                  "ADD siteAssignmentCount :minusOne SET updatedAt = :now",
                ConditionExpression: "siteAssignmentCount > :zero",
                ExpressionAttributeValues: {
                  ":minusOne": -1,
                  ":zero": 0,
                  ":now": now,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "site_user_assignment_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, { unassigned: true });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getSitePerimeter = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const result = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    if (!result.Item) return jsonResponse(404, { error: "site_not_found" });
    return jsonResponse(200, {
      perimeter: String(result.Item.perimeter ?? ""),
      updatedAt: result.Item.updatedAt,
      perimeterUpdatedAt: result.Item.perimeterUpdatedAt,
      perimeterUpdatedBy: result.Item.perimeterUpdatedBy,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const putSitePerimeter = (event) =>
  siteAdminOnly(event, event.pathParameters?.siteId ?? "", async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    if (typeof body.perimeter !== "string") {
      return jsonResponse(400, { error: "perimeter_required" });
    }
    const perimeter = body.perimeter.trim();
    if (!perimeter) {
      return jsonResponse(400, { error: "perimeter_required" });
    }
    if (perimeter.length > 4000) {
      return jsonResponse(400, { error: "invalid_perimeter" });
    }
    const expectedUpdatedAt = String(body.expectedUpdatedAt ?? "");
    if (!expectedUpdatedAt) {
      return jsonResponse(400, { error: "expected_version_required" });
    }
    const tableName = getDynamoTableName();
    const now = new Date().toISOString();
    const actor = String(
      /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
        "central-admin",
    );
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk: `SITE#${siteId}`, sk: "#META" },
                UpdateExpression:
                  "SET perimeter = :perimeter, perimeterUpdatedAt = :now, perimeterUpdatedBy = :actor, updatedAt = :now",
                ConditionExpression:
                  "attribute_exists(pk) AND updatedAt = :expectedUpdatedAt",
                ExpressionAttributeValues: {
                  ":perimeter": perimeter,
                  ":now": now,
                  ":actor": actor,
                  ":expectedUpdatedAt": expectedUpdatedAt,
                },
              },
            },
            put({
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "perimeter_text_updated",
              siteId,
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "perimeter_update_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      perimeter,
      updatedAt: now,
      perimeterUpdatedAt: now,
      perimeterUpdatedBy: actor,
    });
  });

/**
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, unknown>} user
 * @param {string} now
 * @returns {Record<string, unknown>}
 */
function primaryContactUpdate(tableName, siteId, user, now) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: "#META" },
      UpdateExpression:
        "SET primaryContactUserId = :userId, primaryContact = :contact, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":userId": user.userId,
        ":contact": {
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          email: user.email,
        },
        ":now": now,
      },
    },
  };
}

/**
 * Resolve the authenticated letter sender and enforce Site assignment for
 * Compliance managers. Supervisors intentionally bypass Site assignment.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {string} siteId
 * @param {string} tableName
 */
async function resolveLetterGenerator(event, siteId, tableName) {
  const principal = adminPrincipal(event);
  const email = (principal.email || principal.username)
    .trim()
    .toLocaleLowerCase("en-US");
  if (
    principal.role === ADMIN_GROUPS.supervisor &&
    principal.firstName &&
    principal.lastName &&
    email &&
    principal.phone
  ) {
    return {
      status: 200,
      manager: {
        firstName: principal.firstName,
        lastName: principal.lastName,
        email,
        phone: principal.phone,
        phoneExtension: "",
        departmentName: principal.department,
        userId: principal.subject,
      },
    };
  }
  const directoryResult = email
    ? await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
            sk: `MANAGER#${email}`,
          },
        }),
      )
    : { Item: undefined };
  const directory = directoryResult.Item;
  const manager = {
    firstName: directory?.firstName || principal.firstName,
    lastName: directory?.lastName || principal.lastName,
    email: directory?.email || email,
    phone: directory?.phone || principal.phone,
    phoneExtension: directory?.phoneExtension || "",
    departmentName: directory?.departmentName || principal.department,
    userId: directory?.userId || "",
  };
  if (principal.role === ADMIN_GROUPS.supervisor) {
    return { status: 200, manager };
  }
  if (!directory?.userId) {
    return { status: 403, error: "compliance_manager_profile_required" };
  }
  const assignment = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: `SITE#${siteId}`,
        sk: `COMPLIANCE_MANAGER#${directory.userId}`,
      },
      ConsistentRead: true,
    }),
  );
  if (!assignment.Item || assignment.Item.status !== "active") {
    return { status: 403, error: "site_assignment_required" };
  }
  return { status: 200, manager };
}

/**
 * @param {Record<string, unknown>} Item
 * @returns {Record<string, unknown>}
 */
function put(Item) {
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
 * @param {unknown} value
 * @returns {string}
 */
function isoDate(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
    ? ""
    : text;
}

/** @param {unknown} value */
function normalizeReasons(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String))]
    .filter((reason) => ["1", "2", "3", "4", "5", "6"].includes(reason))
    .sort();
}

/** @param {string} value */
function nextIsoDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function pacificIsoDate() {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} start
 * @param {string} expiry
 * @returns {"scheduled" | "expired" | "active"}
 */
function termsStatus(start, expiry) {
  const today = pacificIsoDate();
  if (start > today) return "scheduled";
  if (expiry && expiry <= today) return "expired";
  return "active";
}
