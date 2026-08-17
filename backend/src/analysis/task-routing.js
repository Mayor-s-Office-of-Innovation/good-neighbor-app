// Escalation routing: turn a synthesized per-category rollup into an action
// item, classifying each as an on-site staff task or a city escalation. This is
// GNP-owned business logic, not the analyzer's — see
// docs/dynamodb-data-model.md § Task ownership & escalation.
//
// PLACEHOLDER MATRIX. The product team defines the real routing (which
// categories escalate to the city vs. become on-site upkeep, and at what
// severity) later. Until then this makes a defensible guess so the
// complete-check flow produces tasks end-to-end:
//   - severity 0                       → no task
//   - looks hazardous/toxic and sev ≥ 3 → city_escalation (toxic-cleanup queue)
//   - otherwise                        → onsite staff task
// Classification is point-in-time — stamped once at task creation, never re-run
// — so replacing this later does not disturb already-created tasks.

/** @typedef {"onsite" | "city_escalation"} TaskType */

// PLACEHOLDER: keyword hints that a concern is the city's to clean up
// (hazardous/toxic material) rather than routine on-site upkeep. Matched
// case-insensitively against the service's category name. TODO(product):
// replace with the real per-category escalation matrix over the GNA rubric's
// weighted categories.
const ESCALATION_HINTS = [
  "hazard",
  "toxic",
  "biohazard",
  "chemical",
  "needle",
  "syringe",
  "waste",
  "spill",
  "drug",
];

// PLACEHOLDER: minimum severity at which a hazardous concern escalates to the
// city rather than becoming an on-site task.
const ESCALATE_MIN_SEVERITY = 3;

/**
 * Classify one category rollup into a task type, or `null` for "no task".
 * PLACEHOLDER routing — see file header.
 * @param {string} category service category name (e.g. "Litter")
 * @param {number} rating max severity for the category across the check
 * @returns {TaskType | null}
 */
export function classifyTask(category, rating) {
  if (!rating || rating <= 0) return null;
  const name = category.toLowerCase();
  const hazardous = ESCALATION_HINTS.some((hint) => name.includes(hint));
  if (hazardous && rating >= ESCALATE_MIN_SEVERITY) return "city_escalation";
  return "onsite";
}
