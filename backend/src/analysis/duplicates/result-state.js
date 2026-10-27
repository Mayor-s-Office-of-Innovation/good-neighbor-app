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
 * @param {Partial<ConditionOutcome>|undefined} row
 * @returns {boolean}
 */
export function isIncompleteCondition(row) {
  return (
    row?.possibleDuplicate !== true &&
    (row?.assessmentOutcome === "incomplete" ||
      row?.assessmentOutcome === "no_match_with_failures" ||
      (row?.failedCandidateCount ?? 0) > 0)
  );
}

/**
 * Normalize historical failed negatives without rewriting stored results.
 * @param {ConditionOutcome} row
 * @returns {ConditionOutcome}
 */
export function normalizeConditionOutcome(row) {
  return isIncompleteCondition(row)
    ? {
        ...row,
        status: "insufficient_evidence",
        possibleDuplicate: null,
        duplicateOf: null,
        matchStrength: null,
        assessmentOutcome: "incomplete",
      }
    : row;
}

/**
 * @param {{status?:string,conditionResults?:ConditionOutcome[]}|undefined} result
 * @returns {"pending"|"retrying"|"incomplete"|"complete"}
 */
export function processingState(result) {
  if (!result || result.status === "pending") return "pending";
  if (result.status === "failed") return "retrying";
  if (
    result.status === "incomplete" ||
    result.conditionResults?.some(isIncompleteCondition)
  )
    return "incomplete";
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
