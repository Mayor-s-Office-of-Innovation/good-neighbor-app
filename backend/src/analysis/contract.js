// Vendored types for the analysis service response contract, pinned to
// `../street-conditions-analysis/contract/schemas/analysis-response.schema.json`
// (rubric `good-neighbor-app` v1.0.0, re-pinned 2026-08-14). The service owns
// this shape; we adapt to it, never the reverse. Referenced elsewhere via
// `import("./contract.js").AnalysisResponse`, mirroring the repo's
// `import("aws-lambda").X` style. Types only — no runtime coupling to the SDK.

/** @typedef {"Excellent" | "Good" | "Fair" | "Poor" | "Very Poor"} GeneralConditionsLabel */

/**
 * @typedef {object} RubricRef
 * @property {string} id
 * @property {string} version
 */

/**
 * @typedef {object} ModelRef
 * @property {string} provider
 * @property {string} model_id
 */

/**
 * @typedef {object} GeneralConditions
 * @property {GeneralConditionsLabel} label
 * @property {string} description
 */

/**
 * @typedef {object} IdentifiedCondition
 * @property {string} category
 * @property {string} definition
 * @property {number} severity
 * @property {string} [severity_label]
 * @property {string} description
 * @property {number[]} evidence_indices
 * @property {number} [confidence]
 */

/**
 * @typedef {object} AssessmentMetadata
 * @property {string} position_descriptor
 */

/**
 * @typedef {object} Assessment
 * @property {AssessmentMetadata} metadata
 * @property {GeneralConditions} general_conditions
 * @property {IdentifiedCondition[]} identified_conditions_of_concern
 */

/**
 * @typedef {object} AnalysisResponse
 * @property {string} analysis_id
 * @property {RubricRef} rubric
 * @property {string} created_at
 * @property {ModelRef} model
 * @property {{ app_id: string, request_id?: string }} [caller]
 * @property {Assessment} assessment
 */

/** @type {string} */
export const RUBRIC_ID = "good-neighbor-app";

/** @type {string} */
export const RUBRIC_VERSION = "1.0.0";
