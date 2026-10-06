/**
 * @typedef {{ code?: string, status?: string, reason?: string, payload?: {tickets?: Array<{srNum?: string}>} }} AppActionResult
 * @typedef {{ status?: string, appActionResults?: AppActionResult[] }} TaskActionState
 */

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
  const messages = {
    missing_location:
      "We couldn't file this ticket - the site has no location set. Ask an admin to add the site location, then try again.",
    missing_service_code:
      "We couldn't file this ticket - it has no 311 service code. Please try again.",
    feature_disabled:
      "We couldn't complete the 311 submission. Please try again.",
    sf311_timeout:
      "The 311 system didn't respond in time. Please try again in a moment.",
  };
  return (
    messages[result.reason] ||
    "We couldn't file this ticket right now. Please try again."
  );
}
