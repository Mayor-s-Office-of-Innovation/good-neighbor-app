/** @typedef {import('./image-matcher.js').ConditionOutcome} ConditionOutcome */
/**
 * Pending is never a negative. This shape is shared by dispatch, progress and GET.
 * @returns {ConditionOutcome[]}
 * @param {{id:string}[]} conditions
 */
export function pendingConditions(conditions) {
  return conditions.map(({ id }) => ({
    conditionId: id,
    status: "pending",
    possibleDuplicate: null,
    duplicateOf: null,
    matchStrength: null,
  }));
}
/**
 * @param {{status?:string,conditionResults?:ConditionOutcome[]}|undefined} result
 * @returns {"pending"|"retrying"|"complete"}
 */
export function processingState(result) {
  if (!result || result.status === "pending") return "pending";
  if (result.status === "failed") return "retrying";
  return "complete";
}

/** Presentation only: never infer a negative match from overdue work.
 * @param {string} state @param {string|undefined} pendingSince @param {number} [now]
 */
export function visibleDuplicateState(state, pendingSince, now = Date.now()) {
  if (state !== "pending") return state;
  const started = Date.parse(pendingSince ?? "");
  return !Number.isFinite(started) || now - started >= 15 * 60 * 1000
    ? "unavailable"
    : "pending";
}
