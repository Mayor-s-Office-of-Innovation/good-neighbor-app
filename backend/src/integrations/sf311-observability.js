import { emitMetrics } from "../lib/metrics.js";

/** No payloads, URLs, credentials, free-form errors or upstream narratives. */
const reasons = new Set([
  "sf311_timeout",
  "sf311_network_error",
  "sf311_closure_state_unknown",
  "sf311_closure_reconciliation_failed",
  "sf311_creation_uncertain_requires_reconciliation",
  "sf311_attachment_uncertain_requires_reconciliation",
  "note_delivery_unknown",
  "missing_location",
  "insufficient_classifier_information",
  "missing_service_code",
  "no_service_codes",
  "responsible_agency_not_found",
  "missing_srnum",
  "invalid_job",
  "sf311_error",
  "app_action_failed",
  "attachment_submission_failed",
  "attachments_pending",
  "fanout_incomplete",
]);
const operations = new Set([
  "create",
  "close",
  "attachment",
  "note",
  "update",
  "status",
  "agency_lookup",
  "job",
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeReason(value) {
  const reason =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  return reasons.has(reason) || /^hub_\d{1,3}$/.test(reason)
    ? reason
    : /^\d{1,3}$/.test(reason)
      ? `hub_${reason}`
      : "unspecified";
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function needsReconciliation(value) {
  const reason = safeReason(value);
  return (
    reason === "sf311_closure_state_unknown" ||
    reason === "note_delivery_unknown" ||
    reason.endsWith("_requires_reconciliation")
  );
}

/**
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
function records(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object")
    : [];
}

/**
 * @param {unknown} error
 * @returns {{reason: string, category: string, httpStatus?: number}}
 */
export function sf311Failure(error) {
  const e = /** @type {{code?: unknown, status?: unknown}} */ (error ?? {});
  const status = Number(e.status);
  const reason = safeReason(e.code);
  const category =
    status === 401 || status === 403
      ? "authentication"
      : status === 429
        ? "throttled"
        : status >= 500 && status < 600
          ? "server"
          : reason === "sf311_timeout"
            ? "timeout"
            : reason === "sf311_network_error"
              ? "network"
              : "action";
  return {
    reason,
    category,
    ...(Number.isInteger(status) && status >= 100 && status < 600
      ? { httpStatus: status }
      : {}),
  };
}

/**
 * One event per API operation, including reads and calls made outside the queue.
 * Re-throws the original error; monitoring cannot alter retry/receipt semantics.
 * @template T
 * @param {string} operation
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function observeSf311Request(operation, work) {
  const started = Date.now();
  try {
    const result = await work();
    requestEvent(operation, started);
    return result;
  } catch (error) {
    requestEvent(operation, started, sf311Failure(error));
    throw error;
  }
}

/**
 * @param {string} operation
 * @param {number} started
 * @param {ReturnType<typeof sf311Failure>} [failure]
 * @returns {void}
 */
function requestEvent(operation, started, failure) {
  emitMetrics({
    marker: "Sf311Request",
    dimensions: { Operation: operations.has(operation) ? operation : "job" },
    dimensionSets: [[], ["Operation"]],
    props: {
      eventType: "sf311_request",
      outcome: failure ? "failed" : "succeeded",
      ...failure,
    },
    metrics: [
      { name: "Sf311Requests", value: 1 },
      {
        name: "Sf311RequestLatencyMs",
        value: Math.max(0, Date.now() - started),
        unit: "Milliseconds",
      },
      { name: "Sf311RequestFailures", value: failure ? 1 : 0 },
      {
        name: "Sf311ConnectionFailed",
        value: failure && failure.category !== "action" ? 1 : 0,
      },
    ],
  });
}

/**
 * Attempt counts, never unique-job counts. IDs are log properties for distinct
 * job queries. Only terminal/exhausted outcomes page; retries remain diagnosable.
 * @param {string} operation
 * @param {unknown} reason
 * @param {{terminal: boolean, jobId?: string, taskId?: string, siteId?: string, messageId?: string, attempt?: number}} context
 * @returns {void}
 */
export function reportSf311Failure(operation, reason, context) {
  const safe = safeReason(reason);
  const blocked = needsReconciliation(safe);
  /** @type {Record<string, unknown>} */
  const props = {
    eventType: "sf311_action_failure",
    reason: safe,
    outcome: context.terminal ? "needs_attention" : "retrying",
    category: blocked ? "reconciliation" : "action",
  };
  for (const key of /** @type {const} */ ([
    "jobId",
    "taskId",
    "siteId",
    "messageId",
  ])) {
    const value = context[key];
    if (typeof value === "string" && /^[A-Za-z0-9_:#./-]{1,250}$/.test(value))
      props[key] = value;
  }
  if (Number.isInteger(context.attempt) && Number(context.attempt) > 0)
    props.attempt = context.attempt;
  emitMetrics({
    marker: "Sf311ActionFailure",
    dimensions: { Operation: operations.has(operation) ? operation : "job" },
    dimensionSets: [[], ["Operation"]],
    props,
    metrics: [
      { name: "Sf311ActionFailureAttempts", value: 1 },
      {
        name: "Sf311ActionFailed",
        value: context.terminal && !blocked ? 1 : 0,
      },
      {
        name: "Sf311ReconciliationBlocked",
        value: context.terminal && blocked ? 1 : 0,
      },
    ],
  });
}

/**
 * Failure details may live on a ticket/closure, not on its aggregate result.
 * Emit once per failed action per attempt, even if it contains several tickets.
 * @param {import("../analysis/guidance/app-actions.js").AppActionResult[]} results
 * @param {Parameters<typeof reportSf311Failure>[2]} context
 * @returns {void}
 */
export function reportSf311Results(results, context) {
  for (const result of results) {
    if (
      !["create_311_ticket", "close_311_ticket"].includes(result.code) ||
      !["failed", "partial"].includes(result.status)
    )
      continue;
    // Tickets themselves have no status; attachment outcomes are nested one
    // level deeper and uncertain deliveries stay pending, not failed.
    const children = [
      ...records(result.payload?.closures),
      ...records(result.payload?.tickets).flatMap((ticket) =>
        records(ticket.attachments),
      ),
    ];
    const failed = children.filter((item) =>
      ["failed", "partial", "pending"].includes(String(item.status ?? "")),
    );
    const reason =
      failed.find((item) => needsReconciliation(item.reason))?.reason ??
      result.reason ??
      failed.find((item) => item.reason)?.reason;
    reportSf311Failure(
      result.code === "close_311_ticket" ? "close" : "create",
      reason,
      context,
    );
  }
}
