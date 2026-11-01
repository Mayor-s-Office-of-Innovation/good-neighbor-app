import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { siteMetaKey } from "../handlers/keys.js";
import { normalizeSf311Detail } from "../integrations/sf311-status.js";

/** Snapshot once at acceptance; retries never re-evaluate the Site setting.
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} task
 * @param {string} now
 */
export async function deliberate311Decision(tableName, siteId, task, now) {
  if (["production", "simulated"].includes(task.deliberate311DeliveryMode))
    return {
      mode: task.deliberate311DeliveryMode,
      acceptedAt: task.deliberate311AcceptedAt || now,
      checks: [],
    };
  // Upgrade retries accepted before this setting existed. Any recorded City
  // attempt (including an uncertain creation) must stay on its original path.
  const prior = /** @type {Array<Record<string, any>>} */ (
    task.appActionResults || []
  );
  const attempted = prior.find(
    (result) =>
      result.code === "create_311_ticket" &&
      result.payload?.executionTrigger !== "task_created" &&
      result.payload?.tickets?.length,
  );
  if (attempted)
    return {
      mode: attempted.payload.tickets.every(isSimulated311Ticket)
        ? "simulated"
        : "production",
      acceptedAt:
        attempted.payload.tickets[0].submittedAt || attempted.recordedAt || now,
      checks: [],
    };
  const { Item: site } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: siteMetaKey(siteId),
      ConsistentRead: true,
    }),
  );
  const value = site?.deliberate311ProductionEnabled;
  return {
    mode: value === false ? "simulated" : "production",
    acceptedAt: now,
    checks: [
      {
        ConditionCheck: {
          TableName: tableName,
          Key: siteMetaKey(siteId),
          ConditionExpression:
            value === undefined
              ? "attribute_not_exists(deliberate311ProductionEnabled)"
              : "deliberate311ProductionEnabled = :enabled",
          ...(value === undefined
            ? {}
            : { ExpressionAttributeValues: { ":enabled": value } }),
        },
      },
    ],
  };
}

/** @param {Record<string, any>} task @param {string} srNum */
export function filedTicket(task, srNum) {
  const results = /** @type {Array<Record<string, any>>} */ (
    Array.isArray(task.appActionResults) ? task.appActionResults : []
  );
  return results
    .filter((result) => result.code === "create_311_ticket")
    .flatMap((result) => result.payload?.tickets || [])
    .find(
      (/** @type {Record<string, any>} */ ticket) =>
        String(ticket.srNum || "") === srNum,
    );
}

/** @param {Record<string, any>} ticket */
export function isSimulated311Ticket(ticket) {
  return (
    ticket.deliveryMode === "simulated" ||
    String(ticket.srNum || "").startsWith("SIM-")
  );
}

/** A stable reference and clock independent of worker redelivery.
 * @param {string} siteId
 * @param {Record<string, any>} task
 * @param {string} now
 */
export function simulated311Ticket(siteId, task, now) {
  const submittedAt = task.deliberate311AcceptedAt || now;
  const id = createHash("sha256")
    .update(JSON.stringify([siteId, task.taskId, submittedAt]))
    .digest("hex")
    .slice(0, 32);
  return {
    srNum: `SIM-${id}`,
    serviceCode: "simulated",
    status: "submitted",
    deliveryMode: "simulated",
    submittedAt,
    closesAt: new Date(Date.parse(submittedAt) + 300_000).toISOString(),
    closedReason: "1",
  };
}

/** Use the same normalized contract and translated vocabulary as real tickets.
 * @param {Record<string, any>} task
 * @param {Record<string, any>} ticket
 * @param {Date} [now]
 */
export function simulated311Detail(task, ticket, now = new Date()) {
  const closed = now.getTime() >= Date.parse(ticket.closesAt);
  return normalizeSf311Detail({
    task,
    srNum: ticket.srNum,
    now,
    record: {
      SourceAgencyReceiveDate: ticket.submittedAt,
      Status: closed ? "4" : "9",
      ...(closed
        ? {
            ClosedReason: ticket.closedReason,
            Updates: [
              {
                UpdateType: "11",
                NumericSubType: ticket.closedReason,
                EffectiveDate: ticket.closesAt,
              },
            ],
          }
        : {}),
    },
  });
}
