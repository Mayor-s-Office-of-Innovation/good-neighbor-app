import { weightingFor } from "./rubric-meta.js";

// Caller-side adapter: analysis-service `assessment` -> our per-artifact
// projection (the shape persisted on an ANALYSIS# item). Category-agnostic — it
// iterates whatever concerns the response carries rather than expecting a fixed
// category set, and joins each to `rubric-meta` for its weighting. An unknown
// category yields `weighting: null` and is surfaced in `unknownCategories`, so
// rubric drift is visible, never silently mis-weighted.
//
// We adopt the service `grade` (`general_conditions.label`) directly and do NOT
// compute a total_score: the response is an exceptions list, not a per-category
// scorecard, so an unweighted average no longer applies (see the 2026-08-14
// note in docs/dynamodb-data-model.md § Metric definitions).

/** @typedef {import("./contract.js").AnalysisResponse} AnalysisResponse */
/** @typedef {import("./rubric-meta.js").Weighting} Weighting */

/**
 * @typedef {object} AdaptedConcern
 * @property {string} category
 * @property {Weighting | null} weighting
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
 * @property {string[]} unknownCategories
 */

/**
 * @param {AnalysisResponse} response
 * @returns {AdaptedAssessment}
 */
export function adaptAssessment(response) {
  const { assessment, rubric } = response;
  const rubricVersion = rubric.version;

  /** @type {string[]} */
  const unknownCategories = [];

  const concerns = assessment.identified_conditions_of_concern.map((c) => {
    const weighting = weightingFor(c.category, rubricVersion);
    if (weighting === null) unknownCategories.push(c.category);

    /** @type {AdaptedConcern} */
    const concern = {
      category: c.category,
      weighting,
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
    rubricVersion,
    model: response.model,
    grade: assessment.general_conditions.label,
    gradeDescription: assessment.general_conditions.description,
    concerns,
    issueCount: concerns.filter((c) => c.rating > 0).length,
    maxSeverity,
    unknownCategories,
  };
}
