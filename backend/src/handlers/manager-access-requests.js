import { createHash, randomBytes, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { sendManagerAccessEmail } from "../integrations/email.js";
import { emailHash, normalizeEmail } from "./setup-codes.js";

const GRANT_TTL_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_SITES_PER_REQUEST = 10;
const MINIMUM_RESPONSE_MS = 600;
const GENERIC_MESSAGE =
  "If that email is authorized, enrollment instructions will arrive shortly.";

/** Public non-enumerating Site Manager access recovery. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const requestManagerAccess = async (event) => {
  const startedAt = Date.now();
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const email = normalizeEmail(
    String(/** @type {Record<string, unknown>} */ (body ?? {}).email ?? ""),
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return jsonResponse(400, { error: "invalid_request" });
  }

  const verifier = await emailHash(email);
  const sourceIp = String(event.requestContext?.http?.sourceIp ?? "unknown");
  const ipHash = createHash("sha256").update(sourceIp).digest("hex");
  const now = new Date();
  let limitedBy = "";
  if (!(await acquireHourlyLimit(`IP#${ipHash}`, 5, now))) {
    limitedBy = "ip_hour";
  } else if (!(await acquireHourlyLimit(`EMAIL#${verifier}`, 3, now))) {
    limitedBy = "email_hour";
  } else if (!(await acquireCooldown(verifier, now))) {
    limitedBy = "email_cooldown";
  }
  if (limitedBy) {
    console.warn(
      JSON.stringify({ marker: "ManagerAccessThrottled", limitedBy }),
    );
  } else {
    try {
      await issueRecoveryLinks(email, verifier, now);
    } catch {
      console.error(
        JSON.stringify({
          marker: "ManagerAccessRequestFailed",
          level: "ERROR",
        }),
      );
    }
  }
  await minimumDelay(startedAt);
  return jsonResponse(202, { message: GENERIC_MESSAGE });
};

/** @param {string} email @param {string} verifier @param {Date} now */
async function issueRecoveryLinks(email, verifier, now) {
  const tableName = getDynamoTableName();
  const directory = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `MANAGER_EMAIL#${verifier}`,
        ":prefix": "SITE#",
      },
      Limit: MAX_SITES_PER_REQUEST,
    }),
  );
  const memberships = await Promise.all(
    (directory.Items ?? []).map(async (pointer) => {
      const [siteResult, membershipResult] = await Promise.all([
        get(tableName, `SITE#${pointer.siteId}`, "#META"),
        get(
          tableName,
          `SITE#${pointer.siteId}`,
          `MANAGER_MEMBERSHIP#${pointer.membershipId}`,
        ),
      ]);
      const site = siteResult.Item;
      const membership = membershipResult.Item;
      if (
        !site ||
        !membership ||
        site.status === "inactive" ||
        membership.status !== "active" ||
        membership.emailHash !== verifier
      ) {
        return null;
      }
      return { site, membership };
    }),
  );
  /** @type {Array<{site: Record<string, any>, membership: Record<string, any>}>} */
  const eligible = [];
  for (const membership of memberships) {
    if (membership?.site && membership.membership) eligible.push(membership);
  }
  if (!eligible.length) return;

  const issued = [];
  for (const entry of eligible) {
    const result = await issueGrant(
      tableName,
      entry.site,
      entry.membership,
      now,
    );
    if (result) issued.push(result);
  }
  if (!issued.length) return;

  let delivery = { provider: "ses", messageId: "", status: "failed" };
  try {
    const result = await sendManagerAccessEmail({
      to: email,
      managerName: String(eligible[0].membership.name),
      links: issued.map(({ grant, enrollmentUrl }) => ({
        siteName: String(grant.siteName),
        enrollmentUrl,
        expiresAt: String(grant.expiresAt),
      })),
    });
    delivery = { ...result, status: "accepted" };
  } catch {
    // Preserve the generic public response and record delivery failure below.
  }
  await Promise.allSettled(
    issued.map(({ grant }) =>
      ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: grant.pk, sk: grant.sk },
          UpdateExpression:
            "SET deliveryStatus = :deliveryStatus, deliveryProvider = :provider, deliveryMessageId = :messageId, deliveryUpdatedAt = :now",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":deliveryStatus": delivery.status,
            ":provider": delivery.provider,
            ":messageId": delivery.messageId,
            ":now": new Date().toISOString(),
          },
        }),
      ),
    ),
  );
  console.info(
    JSON.stringify({
      marker: "ManagerAccessDelivery",
      status: delivery.status,
      provider: delivery.provider,
      siteCount: issued.length,
    }),
  );
}

/** @param {string} tableName @param {Record<string, any>} site @param {Record<string, any>} membership @param {Date} now */
async function issueGrant(tableName, site, membership, now) {
  const nowIso = now.toISOString();
  const existing = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${site.siteId}`,
        ":prefix": "MANAGER_GRANT#",
      },
      ScanIndexForward: false,
      Limit: 25,
    }),
  );
  const replaced = (existing.Items ?? []).find(
    (item) =>
      item.membershipId === membership.membershipId &&
      item.status === "pending" &&
      item.expiresAt > nowIso,
  );
  const grantId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();
  const grant = {
    pk: `SITE#${site.siteId}`,
    sk: `MANAGER_GRANT#${nowIso}#${grantId}`,
    type: "enrollmentGrant",
    entityType: "ENROLLMENT_GRANT",
    grantId,
    membershipId: membership.membershipId,
    siteId: site.siteId,
    siteName: site.name,
    accessLevel: "manager",
    tokenHash,
    status: "pending",
    deliveryStatus: "queued",
    issuedTo: membership.email,
    issuedBy: "manager-email-recovery",
    createdAt: nowIso,
    expiresAt,
  };
  /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */
  const writes = [
    put(tableName, grant),
    put(tableName, {
      pk: `ENROLLMENT_TOKEN#${tokenHash}`,
      sk: "#META",
      type: "enrollmentGrantToken",
      grantPk: grant.pk,
      grantSk: grant.sk,
      grantId,
      siteId: site.siteId,
      expiresAt,
    }),
    put(tableName, {
      pk: `SITE#${site.siteId}`,
      sk: `AUDIT#${nowIso}#${randomUUID()}`,
      type: "siteAuditEvent",
      eventType: "manager_access_requested",
      siteId: site.siteId,
      membershipId: membership.membershipId,
      grantId,
      ...(replaced ? { replacedGrantId: replaced.grantId } : {}),
      actor: "manager-email-recovery",
      createdAt: nowIso,
    }),
  ];
  if (replaced) {
    writes.push(
      {
        Update: {
          TableName: tableName,
          Key: { pk: replaced.pk, sk: replaced.sk },
          UpdateExpression:
            "SET #status = :replaced, replacedAt = :now, replacedByGrantId = :grantId",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":replaced": "replaced",
            ":now": nowIso,
            ":grantId": grantId,
          },
        },
      },
      {
        Delete: {
          TableName: tableName,
          Key: { pk: `ENROLLMENT_TOKEN#${replaced.tokenHash}`, sk: "#META" },
        },
      },
    );
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  return {
    grant,
    enrollmentUrl: enrollmentLink(
      process.env.PROVIDER_APP_URL ?? "http://localhost:5173/",
      grantId,
      token,
    ),
  };
}

/** @param {string} subject @param {number} limit @param {Date} now */
async function acquireHourlyLimit(subject, limit, now) {
  const hour = now.toISOString().slice(0, 13);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `MANAGER_ACCESS_RATE#${subject}`, sk: `HOUR#${hour}` },
        UpdateExpression:
          "SET expiresAt = :expiresAt, #type = :type ADD requestCount :one",
        ConditionExpression:
          "attribute_not_exists(requestCount) OR requestCount < :limit",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":limit": limit,
          ":type": "managerAccessRateLimit",
          ":expiresAt": Math.floor(now.getTime() / 1000) + 2 * 60 * 60,
        },
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

/** @param {string} verifier @param {Date} now */
async function acquireCooldown(verifier, now) {
  const nowIso = now.toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: getDynamoTableName(),
        Item: {
          pk: `MANAGER_ACCESS_REQUEST#${verifier}`,
          sk: "#COOLDOWN",
          type: "managerAccessRequestThrottle",
          requestedAt: nowIso,
          nextAllowedAt: new Date(now.getTime() + COOLDOWN_MS).toISOString(),
          expiresAt: Math.floor(now.getTime() / 1000) + 60 * 60,
        },
        ConditionExpression:
          "attribute_not_exists(pk) OR nextAllowedAt <= :now",
        ExpressionAttributeValues: { ":now": nowIso },
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

/** @param {number} startedAt */
async function minimumDelay(startedAt) {
  const remaining = MINIMUM_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
}

/** @param {string} tableName @param {string} pk @param {string} sk */
function get(tableName, pk, sk) {
  return ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
}

/** @param {string} appUrl @param {string} grantId @param {string} token */
function enrollmentLink(appUrl, grantId, token) {
  const url = new URL(appUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("enrollment_grant", grantId);
  fragment.set("enrollment_token", token);
  url.hash = fragment.toString();
  return url.toString();
}

/** @param {string} tableName @param {Record<string, unknown>} Item */
function put(tableName, Item) {
  return {
    Put: {
      TableName: tableName,
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}
