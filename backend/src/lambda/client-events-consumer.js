/*
 * Lambda entrypoint for the client-events queue consumer.
 *
 * API Gateway writes each POST /v1/client-events and POST /v1/client-errors
 * body straight to the client-events SQS queue (infra/modules/app/
 * client-events.tf), so no Lambda sits in the request path: a burst of
 * beacons cannot be throttled by PostHog latency or by this function's
 * concurrency, and the client gets its 204 from the gateway. This consumer
 * reads batches of bodies, scrubs them with the same code as the HTTP
 * handlers, and forwards them to PostHog: one `/batch/` call for all the
 * analytics events in the invocation and one for all the error reports.
 *
 * Which scrub applies is decided by the `Kind` message attribute, a constant
 * each gateway integration sets (`client-event` or `client-error`); it is
 * never derived from request data. A message without it is an event.
 *
 * Retry semantics (the one thing the queue adds over the HTTP intake): a
 * failed PostHog call reports every message of that kind as a batch item
 * failure, so SQS redelivers them and, after the redrive limit, parks them in
 * the dead-letter queue. Bodies that fail the scrub are acknowledged and
 * logged with the kind's Dropped marker — retrying garbage never helps.
 * Log-only mode (no PostHog key) acknowledges too; the payloads are in
 * CloudWatch.
 *
 * The user agent arrives inside the body (`ua`, put there by the client)
 * because the gateway passes the body to SQS verbatim and has no safe way to
 * add a header to it; the forwarders parse it exactly as they did the header.
 */

import {
  envelopeUserAgent,
  logDroppedClientEvents,
  scrubClientEventBatch,
  unpackEnvelope,
} from "../handlers/client-events-batch.js";
import { DROPPED_MARKER as ERROR_DROPPED_MARKER } from "../handlers/client-errors.js";
import { forwardClientEventGroups } from "../handlers/event-forwarder.js";
import { forwardClientErrors } from "../handlers/forwarder.js";
import { scrubClientErrorReport } from "../handlers/scrub-client-error.js";
import { logServerError } from "../lib/log-server-error.js";

/** Message attribute naming the intake a body came from. */
export const KIND_ATTRIBUTE = "Kind";
export const KIND_CLIENT_EVENT = "client-event";
export const KIND_CLIENT_ERROR = "client-error";

/**
 * Egress budget per PostHog call. Nothing waits on this function, so it can
 * afford more than the request-path forwarder's 1 s; a timeout here costs a
 * redelivery, not a dropped batch.
 */
export const CONSUMER_FORWARD_TIMEOUT_MS = 5000;

/**
 * @param {import("aws-lambda").SQSRecord} record
 * @returns {unknown} the parsed body, or undefined when it is not JSON
 */
function bodyOf(record) {
  try {
    return JSON.parse(record.body);
  } catch {
    return undefined;
  }
}

/**
 * @param {import("aws-lambda").SQSRecord} record
 * @returns {string}
 */
function kindOf(record) {
  const value = record.messageAttributes?.[KIND_ATTRIBUTE]?.stringValue;
  return value === KIND_CLIENT_ERROR ? KIND_CLIENT_ERROR : KIND_CLIENT_EVENT;
}

/**
 * @param {import("aws-lambda").SQSEvent} event
 * @returns {Promise<import("aws-lambda").SQSBatchResponse>}
 */
export async function consumeClientEvents(event) {
  /** @type {{ messageId: string, reports: import("../handlers/scrub-client-event.js").ScrubbedClientEvent[], ctx: { userAgent?: string } }[]} */
  const eventGroups = [];
  /** @type {{ messageId: string, report: import("../handlers/scrub-client-error.js").ScrubbedErrorReport, ctx: { userAgent?: string } }[]} */
  const errorEntries = [];

  for (const record of event.Records ?? []) {
    const body = bodyOf(record);
    if (kindOf(record) === KIND_CLIENT_ERROR) {
      const report = scrubClientErrorReport(body);
      if (report) {
        errorEntries.push({
          messageId: record.messageId,
          report,
          ctx: { userAgent: envelopeUserAgent(body) },
        });
      } else {
        console.warn(
          JSON.stringify({
            level: "warn",
            marker: ERROR_DROPPED_MARKER,
            reason: "invalid_payload",
            source: "queue",
          }),
        );
      }
      continue;
    }
    const { items, userAgent } = unpackEnvelope(body);
    const { reports, ...counts } = scrubClientEventBatch(items);
    logDroppedClientEvents(counts, "queue");
    if (reports.length > 0) {
      eventGroups.push({
        messageId: record.messageId,
        reports,
        ctx: { userAgent },
      });
    }
  }

  const deps = { timeoutMs: CONSUMER_FORWARD_TIMEOUT_MS };
  const [eventOutcome, errorOutcome] = await Promise.all([
    eventGroups.length > 0
      ? forwardClientEventGroups(eventGroups, deps)
      : Promise.resolve("log-only"),
    errorEntries.length > 0
      ? forwardClientErrors(errorEntries, deps)
      : Promise.resolve("log-only"),
  ]);

  // The forwarders already wrote one ForwardFailed line per payload; here
  // only the redelivery decision is left, per kind.
  const batchItemFailures = [
    ...(eventOutcome === "failed"
      ? eventGroups.map((group) => ({ itemIdentifier: group.messageId }))
      : []),
    ...(errorOutcome === "failed"
      ? errorEntries.map((entry) => ({ itemIdentifier: entry.messageId }))
      : []),
  ];
  return { batchItemFailures };
}

/**
 * @type {import("aws-lambda").SQSHandler}
 */
export const handler = async (event) => {
  try {
    return await consumeClientEvents(event);
  } catch (err) {
    // The forwarder and scrub never throw; anything reaching here is a bug.
    // Log it as a server error (feeds the ServerError alarm) and rethrow so
    // SQS redelivers the whole batch rather than silently dropping it.
    logServerError("client-events-consumer", err);
    throw err;
  }
};
