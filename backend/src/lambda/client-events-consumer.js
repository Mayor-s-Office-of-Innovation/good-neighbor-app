/*
 * Lambda entrypoint for the client-events queue consumer.
 *
 * API Gateway writes each POST /v1/client-events body straight to the
 * client-events SQS queue (infra/modules/app/client-events.tf), so no Lambda
 * sits in the request path: a burst of beacons cannot be throttled by PostHog
 * latency or by this function's concurrency, and the client gets its 204 from
 * the gateway. This consumer reads batches of bodies, scrubs them with the
 * same code as the HTTP handler (handlers/client-events-batch.js), and
 * forwards every event in the batch to PostHog in one `/batch/` call.
 *
 * Retry semantics (the one thing the queue adds over the HTTP intake): a
 * failed PostHog call reports every message that carried events as a batch
 * item failure, so SQS redelivers them and, after the redrive limit, parks
 * them in the dead-letter queue. Bodies that fail the scrub are acknowledged
 * and logged as ClientEventDropped — retrying garbage never helps. Log-only
 * mode (no PostHog key) acknowledges too; the events are in CloudWatch.
 *
 * The user agent arrives inside the body (`ua`, put there by the client)
 * because the gateway passes the body to SQS verbatim and has no safe way to
 * add a header to it; the forwarder parses it into browser/OS/device
 * properties exactly as it did the header.
 */

import {
  logDroppedClientEvents,
  scrubClientEventBatch,
  unpackEnvelope,
} from "../handlers/client-events-batch.js";
import { forwardClientEventGroups } from "../handlers/event-forwarder.js";
import { logServerError } from "../lib/log-server-error.js";

/**
 * Egress budget per PostHog call. Nothing waits on this function, so it can
 * afford more than the request-path forwarder's 1 s; a timeout here costs a
 * redelivery, not a dropped batch.
 */
export const CONSUMER_FORWARD_TIMEOUT_MS = 5000;

/**
 * @param {import("aws-lambda").SQSRecord} record
 * @returns {ReturnType<typeof unpackEnvelope>} the body's items and user
 *   agent, or nothing for an unparseable body
 */
function envelopeOf(record) {
  try {
    return unpackEnvelope(JSON.parse(record.body));
  } catch {
    return { items: [], userAgent: undefined };
  }
}

/**
 * @param {import("aws-lambda").SQSEvent} event
 * @returns {Promise<import("aws-lambda").SQSBatchResponse>}
 */
export async function consumeClientEvents(event) {
  /** @type {{ messageId: string, reports: import("../handlers/scrub-client-event.js").ScrubbedClientEvent[], ctx: { userAgent?: string } }[]} */
  const groups = [];
  for (const record of event.Records ?? []) {
    const { items, userAgent } = envelopeOf(record);
    const { reports, ...counts } = scrubClientEventBatch(items);
    logDroppedClientEvents(counts, "queue");
    if (reports.length > 0) {
      groups.push({ messageId: record.messageId, reports, ctx: { userAgent } });
    }
  }
  if (groups.length === 0) return { batchItemFailures: [] };

  const outcome = await forwardClientEventGroups(groups, {
    timeoutMs: CONSUMER_FORWARD_TIMEOUT_MS,
  });
  if (outcome === "failed") {
    // The forwarder already wrote one ClientEventForwardFailed line per
    // event; here only the redelivery decision is left.
    return {
      batchItemFailures: groups.map((group) => ({
        itemIdentifier: group.messageId,
      })),
    };
  }
  return { batchItemFailures: [] };
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
