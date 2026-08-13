/*
  The streetconditions.org scorecard vocabulary — the ground truth both the mock
  analyzer (src/services/analyzer.js) and the findings logic (src/domain/findings.js)
  build against. Verified against the real export (see docs/take5-plan.md
  "Analyzer contract").

  The rubric is FIXED: the analyzer returns all 12 categories every time, each with a
  severity `rating` 0-3 and a `hazard` boolean. `rating` is SEVERITY, not confidence
  (there is no confidence in the real output).

  Editable here on purpose: the per-category triage/recommended-action layer is
  DEFERRED (docs/take5-plan.md) — when it lands it extends this file, keeping the
  category list the single source of truth.
*/

/** The 12 stable categories, in the order the scorecard returns them. */
export const CATEGORIES = [
  "RV or other inhabited vehicle",
  "Waste & Small Debris",
  "Furniture & Large Debris",
  "Human and Animal Waste",
  "Sharps",
  "Unsheltered Presence",
  "Fire & Safety Hazards",
  "Access Obstruction",
  "Active Drug Use",
  "Public Health Need",
  "Animals",
  "Graffiti",
];

/** rating 0-3 -> a word. Severity is spoken, never number-only (a11y). */
export const SEVERITY_WORD = ["none", "minor", "moderate", "severe"];

/**
 * @param {number} rating 0-3
 * @returns {string}
 */
export function severityWord(rating) {
  return SEVERITY_WORD[rating] || "none";
}
