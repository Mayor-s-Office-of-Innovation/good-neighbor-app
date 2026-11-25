// Cancel every pending enrollment invitation for a Site. Called by site-wide
// revocation after the Site's credential generation moves, so a revocation
// retires outstanding links directly instead of relying only on the generation
// check at redemption. That check skips grants issued before grants carried a
// generation, so this is what retires those.
//
// Only grants issued at or before the revocation (`cutoff`) are cancelled, so a
// late or retried run never cancels invitations issued afterwards to restore
// access.

import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { retireEnrollmentLookup } from "../handlers/enrollment-retention.js";
import { queryAllItems } from "./query-all-items.js";

/** Admin and email-recovery manager grants, and manager-issued staff grants. */
const GRANT_PREFIXES = ["MANAGER_GRANT#", "STAFF_GRANT#"];

/**
 * @param {string} tableName
 * @param {string} siteId
 * @param {{ actor: string, now: string, cutoff: string, operationId?: string }} context
 *   `cutoff`: the revocation's own timestamp (ISO); later grants are left alone
 * @returns {Promise<{ cancelledCount: number, failedCount: number }>}
 */
export async function cancelPendingSiteGrants(tableName, siteId, context) {
  const pages = await Promise.all(
    GRANT_PREFIXES.map((prefix) =>
      queryAllItems({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": prefix,
        },
        ConsistentRead: true,
      }),
    ),
  );
  const pending = pages
    .flatMap((page) => page.Items)
    .filter(
      (grant) =>
        grant.status === "pending" && issuedAt(grant) <= context.cutoff,
    );
  const outcomes = await Promise.all(
    pending.map((grant) => cancelGrant(tableName, siteId, grant, context)),
  );
  const failedCount = outcomes.filter((o) => o === "failed").length;
  const cancelledCount = outcomes.filter((o) => o === "cancelled").length;
  if (cancelledCount) {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: `SITE#${siteId}`,
                sk: `AUDIT#${context.now}#${randomUUID()}`,
                type: "siteAuditEvent",
                eventType: "pending_grants_cancelled_by_revocation",
                siteId,
                cancelledCount,
                ...(context.operationId
                  ? { operationId: context.operationId }
                  : {}),
                actor: context.actor,
                createdAt: context.now,
              },
            },
          },
        ],
      }),
    );
  }
  return { cancelledCount, failedCount };
}

/**
 * Cancel one grant: status, its link and code lookups, and (manager grants)
 * the per-membership "current grant" pointer. If the lookups or pointer have
 * already gone, still cancel the grant itself: redemption requires `pending`.
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} grant
 * @param {{ actor: string, now: string }} context
 * Never throws: a failure is logged and reported to the caller as "failed".
 * @returns {Promise<"cancelled" | "skipped" | "failed">}
 */
async function cancelGrant(tableName, siteId, grant, { actor, now }) {
  const status = {
    TableName: tableName,
    Key: { pk: grant.pk, sk: grant.sk },
    UpdateExpression:
      "SET #status = :cancelled, cancelledAt = :now, cancelledBy = :actor, cancelReason = :reason",
    ConditionExpression: "#status = :pending",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":pending": "pending",
      ":cancelled": "cancelled",
      ":now": now,
      ":actor": actor,
      ":reason": "site_revocation",
    },
  };
  const pointerKey =
    String(grant.sk).startsWith("MANAGER_GRANT#") && grant.membershipId
      ? {
          pk: `SITE#${siteId}`,
          sk: `${grant.issuedBy === "manager-email-recovery" ? "MANAGER_RECOVERY_GRANT_CURRENT" : "MANAGER_GRANT_CURRENT"}#${grant.membershipId}`,
        }
      : null;
  const pointer = pointerKey
    ? [
        {
          Delete: {
            TableName: tableName,
            Key: pointerKey,
            ConditionExpression:
              "attribute_not_exists(pk) OR grantId = :grantId",
            ExpressionAttributeValues: { ":grantId": grant.grantId },
          },
        },
      ]
    : [];
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: status },
          ...[grant.tokenHash, grant.codeHash]
            .filter(Boolean)
            .map((hash) =>
              retireEnrollmentLookup(tableName, grant, hash, "cancelled", now),
            ),
          ...pointer,
        ],
      }),
    );
    return "cancelled";
  } catch (error) {
    if (errorName(error) !== "TransactionCanceledException")
      return failed(error);
  }
  try {
    await ddb.send(new UpdateCommand(status));
  } catch (error) {
    // Redeemed or cancelled meanwhile: nothing left to do.
    if (errorName(error) === "ConditionalCheckFailedException")
      return "skipped";
    return failed(error);
  }
  // Clear the "current grant" pointer too, or issuing a replacement invitation
  // would find this now-cancelled grant and refuse until the pointer expires.
  // Only if it still points here; a newer grant's pointer is left alone.
  if (pointerKey) {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: pointerKey,
          ConditionExpression: "grantId = :grantId",
          ExpressionAttributeValues: { ":grantId": grant.grantId },
        }),
      );
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") failed(error);
    }
  }
  return "cancelled";
}

/**
 * When the grant was issued (ISO). Grant sort keys embed it as
 * `<PREFIX>#<issuedAt>#<grantId>` for rows without `createdAt`; a grant with
 * neither is treated as old enough to cancel.
 * @param {Record<string, any>} grant
 */
function issuedAt(grant) {
  return String(grant.createdAt || String(grant.sk).split("#")[1] || "");
}

/** @param {unknown} error */
function errorName(error) {
  return error instanceof Error ? error.name : "unknown";
}

/** Log without ids or hashes. @param {unknown} error @returns {"failed"} */
function failed(error) {
  console.error(
    JSON.stringify({
      marker: "PendingGrantCancelFailed",
      level: "ERROR",
      reason: errorName(error),
    }),
  );
  return "failed";
}
