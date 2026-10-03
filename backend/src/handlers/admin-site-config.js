import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { adminOnly } from "../lib/admin-auth.js";

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
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const tier = Number(body.tier);
    const requiredChecksPerDay = Number(body.requiredChecksPerDay);
    const effectiveStart = isoDate(body.effectiveStart);
    const expiresOnExclusive = body.expiresOnExclusive
      ? isoDate(body.expiresOnExclusive)
      : "";
    if (!Number.isInteger(tier) || tier < 0 || tier > 4) {
      return jsonResponse(400, { error: "invalid_tier" });
    }
    if (!Number.isInteger(requiredChecksPerDay) || requiredChecksPerDay < 0) {
      return jsonResponse(400, { error: "invalid_check_cadence" });
    }
    if (!effectiveStart) {
      return jsonResponse(400, { error: "invalid_effective_start" });
    }
    if (body.expiresOnExclusive && !expiresOnExclusive) {
      return jsonResponse(400, { error: "invalid_expiry" });
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
    const existing = (termsResult.Items ?? []).filter(
      (item) => item.status !== "cancelled",
    );
    if (existing.some((item) => item.effectiveStart === effectiveStart)) {
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
    const actor = String(
      /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
        "central-admin",
    );
    const terms = {
      pk: `SITE#${siteId}`,
      sk: `COMPLIANCE_TERMS#${effectiveStart}#${termsVersionId}`,
      type: "complianceTerms",
      entityType: "COMPLIANCE_TERMS",
      siteId,
      termsVersionId,
      tier,
      requiredChecksPerDay,
      effectiveStart,
      ...(expiresOnExclusive ? { expiresOnExclusive } : {}),
      status: termsStatus(effectiveStart, expiresOnExclusive),
      createdAt: now,
      createdBy: actor,
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
            "SET latestComplianceTermsVersionId = :version, complianceTermsUpdatedAt = :now, letterState = :dirty, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: {
            ":version": termsVersionId,
            ":now": now,
            ":dirty": "draft_pending",
          },
        },
      },
      put({
        pk: `SITE#${siteId}`,
        sk: `LETTER_JOB#${now}#${letterJobId}`,
        type: "complianceLetterGenerationJob",
        siteId,
        letterJobId,
        termsVersionId,
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
export const assignSiteUser = (event) =>
  adminOnly(event, async (body) => {
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
  adminOnly(event, async () => {
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
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const parts = Object.fromEntries(
    todayParts.map(({ type, value }) => [type, value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (start > today) return "scheduled";
  if (expiry && expiry <= today) return "expired";
  return "active";
}
