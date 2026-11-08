// Every table, CSV and report carries both versions, so old exports stay explainable.

/** Bump when a projection table gains, loses or renames a column. */
export const CONTRACT_VERSION = "insights-v3";

/** Bump when an endpoint's reply gains, loses or renames a field. */
export const API_VERSION = "reporting-v3";

/** Bump when a counting rule changes, even if no column does. */
export const RULE_VERSION = "2026-11-08";

export const RESPONSE_STATES = Object.freeze([
  "awaiting",
  "overdue",
  "onTime",
  "late",
  "unknown",
  "notTimed",
]);

// Insights shows activity, never a pass/fail or score; these words imply one.
// Whole words only, so a name like "unexpectedCount" isn't caught.
const JUDGEMENT_WORDS = new Set([
  "compliant",
  "compliance",
  "require",
  "required",
  "requirement",
  "expected",
  "missed",
  "adherence",
  "percent",
  "percentage",
  "pct",
  "score",
  "pass",
  "passed",
  "fail",
  "failed",
  "rank",
  "ranking",
]);

/**
 * @param {string} name camelCase or snake_case column name
 * @returns {string[]}
 */
const words = (name) =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .flatMap((w) => [w, w.replace(/s$/, "")]);

/**
 * @param {Iterable<string>} columns
 * @returns {void}
 */
export function assertNoJudgementFields(columns) {
  const bad = [...columns].filter((name) =>
    words(name).some((w) => JUDGEMENT_WORDS.has(w)),
  );
  if (bad.length)
    throw new Error(`judgement fields not allowed: ${bad.join(", ")}`);
}
