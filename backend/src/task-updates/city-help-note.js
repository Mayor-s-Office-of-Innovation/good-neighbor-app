import {
  withSilent311Guard,
  isSilent311Ticket,
  Silent311Suppressed,
} from "../domain/silent-311.js";
import { openFiledTicketNumbers } from "../domain/open-filed-tickets.js";
import { reportSf311Failure } from "../integrations/sf311-observability.js";
import { logServerError } from "../lib/log-server-error.js";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { sf311NoteJob } from "../analysis/guidance/sf311-job.js";
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
 * @param {boolean} [terminal] False when a queued job will try again.
 */
export function logCityNoteFailure(stage, error, update, terminal = true) {
  reportSf311Failure(
    "note",
    stage === "reconciliation" && !(error instanceof Sf311Error)
      ? "note_delivery_unknown"
      : error instanceof Sf311Error
        ? error.code
        : undefined,
    {
      terminal,
      taskId: update.taskId,
      jobId: update.updateId,
    },
  );
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
      integration: "sf311",
      stage,
      taskId: update.taskId,
      updateId: update.updateId,
      ...(/^[\w.-]{1,80}$/.test(code) ? { code } : {}),
    },
  });
}

/**
 * The first recorded filing without a successful closure.
 * @param {{appActionResults?: Array<{code?: string, payload?: {tickets?: Array<{srNum?: string}>}}>}} task
 * @returns {string}
 */
export function cityHelpTicket(task) {
  return openFiledTicketNumbers(task)[0] || "";
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
 * Whether a saved update still has a note for the City to receive.
 * @param {Record<string, any>} update
 * @returns {boolean}
 */
export function isCityHelpNoteOutstanding(update) {
  return Boolean(
    update.cityNotePayload &&
      !["sent", "suppressed", "failed"].includes(update.cityNoteStatus) &&
      // Simulated (training) tickets don't exist in HUB, so there's nothing to send.
      !String(update.cityNotePayload.SRnum || "").startsWith("SIM-"),
  );
}

/**
 * Make sure an outstanding note has a background job, for a replayed request.
 * New notes get their job in the same transaction as the update (see
 * `sf311NoteJob`). The job key comes from the update ID, so this is a no-op
 * when the job already exists.
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} update
 * @returns {Promise<void>}
 */
export async function queueCityHelpNote(tableName, siteId, update) {
  if (!isCityHelpNoteOutstanding(update)) return;
  const job = sf311NoteJob({
    tableName,
    siteId,
    taskId: String(update.taskId),
    updateId: String(update.updateId),
    occurredAt: String(update.occurredAt),
    now: new Date().toISOString(),
  });
  try {
    await ddb.send(new PutCommand(/** @type {any} */ (job.Put)));
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return;
    throw error;
  }
}

/**
 * The timeline event is a durable delivery record. An exclusive claim prevents
 * concurrent sends; an uncertain send is reconciled, never blindly repeated.
 * True means the note is settled (sent, suppressed, or nothing to send). On
 * false, `update.cityNoteStatus` says where it stands: `pending` (never sent),
 * `unknown` (may have arrived) or `failed` (rejected, never retried).
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} update
 * @param {{terminal?: boolean, failOnRejection?: boolean}} [options]
 *   For the queued job: `terminal: false` reports failures as retrying, and
 *   `failOnRejection` marks a HUB rejection `failed` instead of leaving it
 *   `pending` for a user retry.
 * @returns {Promise<boolean>}
 */
export async function deliverCityHelpNote(tableName, siteId, update, options) {
  if (
    !update.cityNotePayload ||
    ["sent", "suppressed"].includes(update.cityNoteStatus) ||
    String(update.cityNotePayload.SRnum || "").startsWith("SIM-")
  )
    return true;
  if (update.cityNoteStatus === "failed") return false;
  if (process.env.GNP_311_SUBMISSION_ENABLED !== "true") return false;
  const { Item: task } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: `TASK#${update.taskId}` },
      ConsistentRead: true,
    }),
  );
  if (!task) return false;
  if (!isSilent311Ticket(task, String(update.cityNotePayload.SRnum || "")))
    return deliverCityHelpNoteInner(tableName, siteId, update, options);
  try {
    return await withSilent311Guard(String(task.createdAt || ""), () =>
      deliverCityHelpNoteInner(tableName, siteId, update, options),
    );
  } catch (error) {
    if (error instanceof Silent311Suppressed)
      return suppressCityHelpNote(tableName, siteId, update);
    throw error;
  }
}

/** Suppress only unclaimed work or an expired lease we observed; never steal delivery.
 * @param {string} tableName @param {string} siteId @param {Record<string, any>} update
 */
async function suppressCityHelpNote(tableName, siteId, update) {
  const lease = update.cityNoteLeaseExpiresAt;
  const now = new Date().toISOString();
  if (lease && !(Date.parse(lease) <= Date.parse(now))) return false;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: taskUpdateKey(
          siteId,
          update.taskId,
          update.occurredAt,
          update.updateId,
        ),
        UpdateExpression:
          "SET cityNoteStatus = :suppressed REMOVE cityNoteLeaseExpiresAt",
        ConditionExpression:
          "cityNoteStatus = :prior AND " +
          (lease
            ? "cityNoteLeaseExpiresAt = :lease AND cityNoteLeaseExpiresAt <= :now"
            : "attribute_not_exists(cityNoteLeaseExpiresAt)"),
        ExpressionAttributeValues: {
          ":suppressed": "suppressed",
          ":prior": update.cityNoteStatus,
          ...(lease ? { ":lease": lease, ":now": now } : {}),
        },
      }),
    );
    update.cityNoteStatus = "suppressed";
    delete update.cityNoteLeaseExpiresAt;
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return false;
    throw error;
  }
}

/**
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} update
 * @param {{terminal?: boolean, failOnRejection?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
async function deliverCityHelpNoteInner(tableName, siteId, update, options) {
  const terminal = options?.terminal ?? true;
  if (
    !update.cityNotePayload ||
    ["sent", "suppressed"].includes(update.cityNoteStatus)
  )
    return true;
  if (String(update.cityNotePayload.SRnum || "").startsWith("SIM-"))
    return true;
  if (update.cityNoteStatus === "failed") return false;
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
    delete update.cityNoteLeaseExpiresAt;
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
      logCityNoteFailure(stage, error, update, terminal);
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
          terminal,
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
    if (error instanceof Silent311Suppressed) {
      await state("suppressed");
      return true;
    }
    // Only explicit HUB validation rejections prove the note was not accepted.
    const rejected =
      error instanceof Sf311Error &&
      /^(21|23|24|25|26|27|28|29)$/.test(String(error.code));
    // A queued job doesn't retry a rejection, so that one always alerts.
    const failed = rejected && options?.failOnRejection === true;
    logCityNoteFailure(stage, error, update, terminal || failed);
    await state(failed ? "failed" : rejected ? "pending" : "unknown").catch(
      (error) => logCityNoteFailure("checkpoint", error, update, terminal),
    );
    return false;
  }
}
