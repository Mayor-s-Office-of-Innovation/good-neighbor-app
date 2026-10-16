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
