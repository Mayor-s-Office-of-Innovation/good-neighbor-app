// Check-level synthesis: fold the per-artifact adapted assessments of one
// perimeter run (all sides) into a single scorecard. The output shape maps
// directly onto the CHECK# header extension persisted at `complete` (see
// docs/dynamodb-data-model.md § synthesis-on-header): one CHECK# = one full run.
//
// The service grades each analyzed position; rolling those up into one perimeter
// grade (worst across sides) is GNP synthesis, so it lives here. This is also the
// seam the escalation classifier (built in handlers/checks.js via task-routing.js,
// still a placeholder matrix) consumes — per-category max rating + source
// artifacts, keyed off the category identity the service returns.

/** @typedef {import("./adapt-scorecard.js").AdaptedAssessment} AdaptedAssessment */
/** @typedef {import("./contract.js").GeneralConditionsLabel} GeneralConditionsLabel */

/**
 * @typedef {object} AnalyzedArtifact
 * @property {string} artifactId
 * @property {string} [side]
 * @property {AdaptedAssessment} adapted
 */

/**
 * @typedef {object} CategoryRollup
 * @property {string} category
 * @property {number} maxRating
 * @property {string[]} sourceArtifactIds
 */

/**
 * @typedef {object} CheckScorecard
 * @property {GeneralConditionsLabel | null} grade
 * @property {string | null} summary
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
  // Overall check summary (Option B — PROVISIONAL, pending team review): rather
  // than compose our own prose, we surface the analyzer's own
  // general_conditions.description (adapted.gradeDescription) from the side that
  // set the worst grade, so the one-line summary stays coherent with the grade we
  // display. First artifact reaching the worst grade wins on ties. Persisted onto
  // the CHECK# header at complete-time so the home screen reads it from listChecks
  // without a detail fetch. If the team revisits this, this is the only seam to
  // change (plus the header persistence in handlers/checks.js).
  /** @type {string | null} */
  let summary = null;
  /** @type {string | null} */
  let rubricVersion = null;
  /** @type {Map<string, CategoryRollup>} */
  const byCategory = new Map();

  for (const { artifactId, adapted } of artifacts) {
    const worse = worseGrade(grade, adapted.grade);
    if (worse !== grade) {
      grade = worse;
      summary = adapted.gradeDescription || null;
    }
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
          maxRating: concern.rating,
          sourceArtifactIds: [artifactId],
        });
      }
    }
  }

  const categories = [...byCategory.values()];
  const maxSeverity = categories.reduce(
    (max, c) => Math.max(max, c.maxRating),
    0,
  );

  return {
    grade,
    summary,
    rubricVersion,
    categories,
    issueCount: categories.filter((c) => c.maxRating > 0).length,
    maxSeverity,
  };
}
