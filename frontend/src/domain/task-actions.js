/**
 * @typedef {{ code?: string, status?: string, reason?: string }} AppActionResult
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
  return task?.status === "completed" && hasSubmitted311Ticket(task);
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
      "We couldn't file this ticket - the site has no location set. Ask an admin to add the site location, or use \"Can't\" to dismiss this card.",
    missing_service_code:
      "We couldn't file this ticket - it has no 311 service code. Use \"Can't\" to dismiss this card.",
    feature_disabled:
      "311 filing isn't enabled yet. Use \"Can't\" to dismiss this card.",
    sf311_timeout:
      "The 311 system didn't respond in time. Please try again in a moment.",
  };
  return (
    messages[result.reason] ||
    "We couldn't file this ticket right now. Please try again."
  );
}
