import { logServerError } from "../lib/log-server-error.js";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getConfig } from "../config.js";
import { ddb } from "../db.js";
import { siteMetaKey, taskUpdateKey } from "../handlers/keys.js";
import {
  buildNoteUpdatePayload,
  createSf311Client,
  getSf311BasicAuth,
  Sf311Error,
} from "../integrations/sf311-client.js";
import { findServiceRequest } from "../integrations/sf311-status.js";

/** Log stage and identifiers without serializing HUB payloads or error messages.
 * @param {string} stage
 * @param {unknown} error
 * @param {Record<string, any>} update
 */
export function logCityNoteFailure(stage, error, update) {
  const safe = new Error(`City note ${stage} failed`);
  if (error instanceof Error) {
    safe.name = /^[\w.-]{1,80}$/.test(error.name) ? error.name : "Error";
    safe.stack = `${safe.name}: ${safe.message}\n${(error.stack || "")
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .join("\n")}`;
  }
  const code = error instanceof Sf311Error ? String(error.code || "") : "";
  logServerError("city-note", safe, {
    extra: {
      stage,
      taskId: update.taskId,
      updateId: update.updateId,
      ...(/^[\w.-]{1,80}$/.test(code) ? { code } : {}),
    },
  });
}

/**
 * The same first filed request displayed by the 311 card.
 * @param {{appActionResults?: Array<{code?: string, payload?: {tickets?: Array<{srNum?: string}>}}>}} task
 * @returns {string}
 */
export function cityHelpTicket(task) {
  for (const result of task.appActionResults || []) {
    if (result.code !== "create_311_ticket") continue;
    const tickets = /** @type {Array<{srNum?: string}>} */ (
      result.payload?.tickets || []
    );
    const ticket = tickets.find((ticket) => ticket.srNum);
    if (ticket) return String(ticket.srNum);
  }
  return "";
}

/**
 * Build the note from authenticated site metadata, never a client-supplied name or SR.
 * @param {string} tableName
 * @param {string} siteId
 * @param {string} srNum
 * @param {string} occurredAt
 * @returns {Promise<Record<string, string>>}
 */
export async function prepareCityHelpNote(
  tableName,
  siteId,
  srNum,
  occurredAt,
) {
  const { Item: site } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: siteMetaKey(siteId),
      ConsistentRead: true,
    }),
  );
  if (!site?.name) throw new Error("Site name unavailable");
  return buildNoteUpdatePayload({
    srNum,
    siteName: String(site.name),
    now: new Date(occurredAt),
  });
}

/**
 * Check only the target SR and the immutable payload's timestamp/text.
 * @param {unknown} body
 * @param {Record<string, string>} payload
 * @returns {boolean}
 */
export function cityHelpNoteExists(body, payload) {
  const request = findServiceRequest(body, payload.SRnum);
  if (!request) return false;
  const updates = request.Updates ||
    request.updates ||
    request.Update ||
    request.StatusUpdates || [request];
  return (
    Array.isArray(updates) &&
    updates.some(
      (update) =>
        String(update.UpdateType) === payload.UpdateType &&
        String(update.SendingAgency) === payload.SendingAgency &&
        String(update.Notes) === payload.Notes &&
        String(update.EffectiveDate).replace("T", " ").slice(0, 19) ===
          payload.EffectiveDate,
    )
  );
}

/**
 * The timeline event is a durable delivery record. An exclusive claim prevents
 * concurrent sends; an uncertain send is reconciled, never blindly repeated.
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} update
 * @returns {Promise<boolean>}
 */
export async function deliverCityHelpNote(tableName, siteId, update) {
  if (!update.cityNotePayload || update.cityNoteStatus === "sent") return true;
  if (process.env.GNP_311_SUBMISSION_ENABLED !== "true") return false;
  const Key = taskUpdateKey(
    siteId,
    update.taskId,
    update.occurredAt,
    update.updateId,
  );
  const now = new Date();
  const priorStatus = update.cityNoteStatus;
  if (
    priorStatus === "sending" &&
    Date.parse(update.cityNoteLeaseExpiresAt || "") > now.getTime()
  )
    return false;
  const lease = new Date(now.getTime() + 60_000).toISOString();
  /**
   * @param {string} status
   * @returns {Promise<void>}
   */
  const state = async (status) => {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key,
        UpdateExpression:
          "SET cityNoteStatus = :status REMOVE cityNoteLeaseExpiresAt",
        ConditionExpression:
          "cityNoteStatus = :sending AND cityNoteLeaseExpiresAt = :lease",
        ExpressionAttributeValues: {
          ":status": status,
          ":sending": "sending",
          ":lease": lease,
        },
      }),
    );
    update.cityNoteStatus = status;
  };
  let client;
  let stage = "configuration";
  try {
    // Validate configuration before claiming an outbound attempt.
    const config = getConfig();
    if (!config.sf311UpdateSrUrl) throw new Error("UpdateSR URL missing");
    await getSf311BasicAuth(config);
    client = createSf311Client({ config });
    stage = "claim";
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key,
        UpdateExpression:
          "SET cityNoteStatus = :sending, cityNoteLeaseExpiresAt = :lease",
        ConditionExpression:
          "cityNoteStatus = :prior AND (attribute_not_exists(cityNoteLeaseExpiresAt) OR cityNoteLeaseExpiresAt <= :now)",
        ExpressionAttributeValues: {
          ":sending": "sending",
          ":prior": priorStatus,
          ":lease": lease,
          ":now": now.toISOString(),
        },
      }),
    );
  } catch (error) {
    if (
      !(
        stage === "claim" &&
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
    )
      logCityNoteFailure(stage, error, update);
    return false;
  }
  try {
    if (priorStatus !== "pending") {
      stage = "reconciliation";
      const latest = await client.getLatestUpdatesBySourceAgency();
      if (!cityHelpNoteExists(latest, update.cityNotePayload)) {
        logCityNoteFailure(
          "reconciliation",
          new Error("Delivery not found"),
          update,
        );
        stage = "checkpoint";
        await state("unknown");
        return false;
      }
    } else {
      stage = "outbound";
      const receipt = await client.updateServiceRequest(update.cityNotePayload);
      if (!receipt.updateId) throw new Error("City response has no update ID");
    }
    stage = "checkpoint";
    await state("sent");
    return true;
  } catch (error) {
    logCityNoteFailure(stage, error, update);
    // Only explicit HUB validation rejections prove the note was not accepted.
    const rejected =
      error instanceof Sf311Error &&
      /^(21|23|24|25|26|27|28|29)$/.test(String(error.code));
    await state(rejected ? "pending" : "unknown").catch((error) =>
      logCityNoteFailure("checkpoint", error, update),
    );
    return false;
  }
}
