// Caller-side adapter: analysis-service `assessment` -> our per-artifact
// projection (the shape persisted on an ANALYSIS# item). A thin projection —
// the service totally owns the rubric, the grade, and the concerns; we only
// reshape to our naming, drop fields we don't persist (confidence/definition),
// and precompute two rollups. Keeping it thin decouples our stored item shape
// from the wire shape, so a contract tweak doesn't ripple into DynamoDB items.
//
// We adopt the service `grade` (`general_conditions.label`) directly and do NOT
// compute a total_score: the grade is already computed server-side from every
// category's severity × weighting, so no rubric data needs to live here. (The
// escalation classifier — built in handlers/checks.js via task-routing.js, still
// a placeholder matrix pending product input — routes concerns via a GNP-owned
// policy keyed off category + severity, sourcing any rubric weightings from the
// service rather than a vendored copy.)

/** @typedef {import("./contract.js").AnalysisResponse} AnalysisResponse */

/**
 * @typedef {object} AdaptedConcern
 * @property {string} category
 * @property {number} rating
 * @property {string} [ratingLabel]
 * @property {string} explanation
 * @property {number[]} evidenceIndices
 */

/**
 * @typedef {object} AdaptedAssessment
 * @property {string} analysisId
 * @property {string} rubricVersion
 * @property {import("./contract.js").ModelRef} model
 * @property {import("./contract.js").GeneralConditionsLabel} grade
 * @property {string} gradeDescription
 * @property {AdaptedConcern[]} concerns
 * @property {number} issueCount
 * @property {number} maxSeverity
 */

/**
 * @param {AnalysisResponse} response
 * @returns {AdaptedAssessment}
 */
export function adaptAssessment(response) {
  const { assessment } = response;

  const concerns = assessment.identified_conditions_of_concern.map((c) => {
    /** @type {AdaptedConcern} */
    const concern = {
      category: c.category,
      rating: c.severity,
      explanation: c.description,
      evidenceIndices: c.evidence_indices ?? [],
    };
    if (c.severity_label !== undefined) concern.ratingLabel = c.severity_label;
    return concern;
  });

  const maxSeverity = concerns.reduce((max, c) => Math.max(max, c.rating), 0);

  return {
    analysisId: response.analysis_id,
    rubricVersion: response.rubric.version,
    model: response.model,
    grade: assessment.general_conditions.label,
    gradeDescription: assessment.general_conditions.description,
    concerns,
    issueCount: concerns.filter((c) => c.rating > 0).length,
    maxSeverity,
  };
}
