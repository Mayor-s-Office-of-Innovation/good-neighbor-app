/**
 * @typedef {{ code?: string, status?: string, reason?: string, payload?: {tickets?: Array<{srNum?: string}>} }} AppActionResult
 * @typedef {{ status?: string, appActionStatus?: string, inProgressActionKind?: string, appActionResults?: AppActionResult[] }} TaskActionState
 */
import { t } from "../i18n/i18n.js";

/** Failures another try can't fix; matches the SF311 job worker's list. */
const PERMANENT_311_REASONS = new Set([
  "missing_location",
  "insufficient_classifier_information",
  "missing_service_code",
  "no_service_codes",
  "responsible_agency_not_found",
]);

/**
 * Where a background "File 311 ticket" tap stands: "queued"
 * while the worker files it, "failed" once it gave up, "" otherwise
 * (including filings that ran inside the request).
 * @param {TaskActionState | null | undefined} task
 * @returns {"queued" | "failed" | ""}
 */
export function filing311State(task) {
  if (
    task?.status !== "in_progress" ||
    task.inProgressActionKind !== "311_filed"
  )
    return "";
  if (task.appActionStatus === "queued") return "queued";
  if (task.appActionStatus === "failed" && !hasSubmitted311Ticket(task))
    return "failed";
  return "";
}

/**
 * A failed background filing that another tap could fix.
 * @param {TaskActionState | null | undefined} task
 * @returns {boolean}
 */
export function canRetry311Filing(task) {
  if (filing311State(task) !== "failed") return false;
  const reason = create311Result(task)?.reason || "";
  return (
    !PERMANENT_311_REASONS.has(reason) &&
    !reason.endsWith("_requires_reconciliation")
  );
}

/**
 * Why a background filing failed, in words for the card.
 * @param {TaskActionState | null | undefined} task
 * @returns {string}
 */
export function filing311FailureMessage(task) {
  if (filing311State(task) !== "failed") return "";
  const reason = create311Result(task)?.reason || "";
  if (reason.endsWith("_requires_reconciliation"))
    return t("taskAction.failure.creationUncertain");
  if (reason === "attachment_submission_failed")
    return t("taskAction.failure.photosFailed");
  if (reason === "missing_location")
    return t("taskAction.failure.missingLocation");
  // The other shared messages end in "try again"; these can't be retried.
  if (PERMANENT_311_REASONS.has(reason))
    return t("taskAction.failure.cannotFile");
  return (
    appActionFailureMessage(task, { includeUnsubmitted311: true }) ||
    t("taskAction.failure.default")
  );
}

/**
 * @param {TaskActionState | null | undefined} task
 * @returns {AppActionResult | undefined}
 */
function create311Result(task) {
  return (
    Array.isArray(task?.appActionResults) ? task.appActionResults : []
  ).find((result) => result?.code === "create_311_ticket");
}

/**
 * @param {TaskActionState | null | undefined} task
 * @returns {boolean}
 */
export function hasSubmitted311Ticket(task) {
  const results = Array.isArray(task?.appActionResults)
    ? task.appActionResults
    : [];
  return results.some(
    (result) =>
      result?.code === "create_311_ticket" && result.status === "submitted",
  );
}

/**
 * @param {TaskActionState | null | undefined} task
 * @returns {boolean}
 */
export function isFiled311Completion(task) {
  return (
    ["in_progress", "completed"].includes(task?.status || "") &&
    hasSubmitted311Ticket(task)
  );
}

/**
 * A "File 311 ticket" tap the server accepted: filed in the request, or
 * queued for the background worker.
 * @param {TaskActionState | null | undefined} task
 * @returns {boolean}
 */
export function isAccepted311Filing(task) {
  return isFiled311Completion(task) || filing311State(task) === "queued";
}

/**
 * @param {TaskActionState | null | undefined} task
 * @returns {string}
 */
export function submitted311ServiceRequestNumber(task) {
  const results = Array.isArray(task?.appActionResults)
    ? task.appActionResults
    : [];
  for (const result of results) {
    if (result?.code !== "create_311_ticket") continue;
    const ticket = result?.payload?.tickets?.find((item) => item?.srNum);
    if (ticket?.srNum) return String(ticket.srNum);
  }
  return "";
}

/**
 * @param {TaskActionState | null | undefined} task
 * @param {{ includeUnsubmitted311?: boolean }} [opts]
 * @returns {string | null}
 */
export function appActionFailureMessage(
  task,
  { includeUnsubmitted311 = false } = {},
) {
  // Completion is authoritative for the user's action. Background 311
  // notification/closure failures remain in the audit results even when the
  // action saved successfully. Explicit filing still requires a submitted SR.
  if (
    !includeUnsubmitted311 &&
    ["completed", "in_progress", "cannot_do"].includes(task?.status || "")
  ) {
    return null;
  }
  const results = Array.isArray(task?.appActionResults)
    ? task.appActionResults
    : [];
  const result =
    (includeUnsubmitted311
      ? results.find((candidate) => candidate?.code === "create_311_ticket")
      : null) || results.find((candidate) => candidate?.status === "failed");
  if (!result) return null;
  if (result.status === "submitted") return null;
  /** Backend failure reason -> translation key. */
  const messageKeys = {
    missing_location: "taskAction.failure.missingLocation",
    missing_service_code: "taskAction.failure.missingServiceCode",
    feature_disabled: "taskAction.failure.featureDisabled",
    sf311_timeout: "taskAction.failure.sf311Timeout",
  };
  return t(messageKeys[result.reason] || "taskAction.failure.default");
}
