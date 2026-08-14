// Check-level synthesis: fold the per-artifact adapted assessments of one
// perimeter run (all sides) into a single scorecard. The output shape maps
// directly onto the CHECK# header extension persisted at `complete` (see
// docs/dynamodb-data-model.md § synthesis-on-header): one CHECK# = one full run.
//
// This is the seam the deferred escalation classifier will consume — it exposes
// exactly the signals the classifier needs (per-category weighting + max rating
// + source artifacts). The classifier itself is NOT built here (Step C).

/** @typedef {import("./adapt-scorecard.js").AdaptedAssessment} AdaptedAssessment */
/** @typedef {import("./adapt-scorecard.js").AdaptedConcern} AdaptedConcern */
/** @typedef {import("./contract.js").GeneralConditionsLabel} GeneralConditionsLabel */
/** @typedef {import("./rubric-meta.js").Weighting} Weighting */

/**
 * @typedef {object} AnalyzedArtifact
 * @property {string} artifactId
 * @property {string} [side]
 * @property {AdaptedAssessment} adapted
 */

/**
 * @typedef {object} CategoryRollup
 * @property {string} category
 * @property {Weighting | null} weighting
 * @property {number} maxRating
 * @property {string[]} sourceArtifactIds
 */

/**
 * @typedef {object} CheckScorecard
 * @property {GeneralConditionsLabel | null} grade
 * @property {string | null} rubricVersion
 * @property {CategoryRollup[]} categories
 * @property {number} issueCount
 * @property {number} maxSeverity
 */

// Worst-first: index in this list is the severity ordering used to pick the
// check grade (the worst grade across the run's artifacts).
/** @type {GeneralConditionsLabel[]} */
const GRADE_ORDER = ["Excellent", "Good", "Fair", "Poor", "Very Poor"];

/**
 * @param {GeneralConditionsLabel | null} a
 * @param {GeneralConditionsLabel} b
 * @returns {GeneralConditionsLabel}
 */
const worseGrade = (a, b) =>
  a === null || GRADE_ORDER.indexOf(b) > GRADE_ORDER.indexOf(a) ? b : a;

/**
 * @param {AnalyzedArtifact[]} artifacts
 * @returns {CheckScorecard}
 */
export function synthesizeCheck(artifacts) {
  /** @type {GeneralConditionsLabel | null} */
  let grade = null;
  /** @type {string | null} */
  let rubricVersion = null;
  /** @type {Map<string, CategoryRollup>} */
  const byCategory = new Map();

  for (const { artifactId, adapted } of artifacts) {
    grade = worseGrade(grade, adapted.grade);
    rubricVersion ??= adapted.rubricVersion;

    for (const concern of adapted.concerns) {
      const existing = byCategory.get(concern.category);
      if (existing) {
        existing.maxRating = Math.max(existing.maxRating, concern.rating);
        if (!existing.sourceArtifactIds.includes(artifactId)) {
          existing.sourceArtifactIds.push(artifactId);
        }
      } else {
        byCategory.set(concern.category, {
          category: concern.category,
          weighting: concern.weighting,
          maxRating: concern.rating,
          sourceArtifactIds: [artifactId],
        });
      }
    }
  }

  const categories = [...byCategory.values()];
  const maxSeverity = categories.reduce((max, c) => Math.max(max, c.maxRating), 0);

  return {
    grade,
    rubricVersion,
    categories,
    issueCount: categories.filter((c) => c.maxRating > 0).length,
    maxSeverity,
  };
}
