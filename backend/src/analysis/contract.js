// Vendored types for the analysis service response contract, pinned to
// `../street-conditions-analysis/contract/schemas/analysis-response.schema.json`
// (rubric `good-neighbor-app` v2.0.0, re-pinned 2026-10-08). The service owns
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
 * A `translations` block on one identified condition: localized copies of the
 * model-written display fields, present only when the caller requested a
 * supported non-English `language`. One language per analyze call; we store
 * it as a per-locale map (see analysis/translations.js) and fill the other
 * locales in the background.
 * @typedef {object} ConditionTranslations
 * @property {string} language
 * @property {string} user_friendly_label
 * @property {string} description
 */

/**
 * `POST /v1/translations` — text-only, stateless: translate the two
 * model-written fields of each item into every requested locale in one model
 * call. Items echo back by `id`; a locale the service could not produce is
 * simply absent from that item's map (never an error).
 * @typedef {object} TranslateRequestItem
 * @property {string} id
 * @property {string} user_friendly_label
 * @property {string} description
 *
 * @typedef {object} TranslateRequest
 * @property {string[]} languages BCP-47 tags (es/vi/fil/zh-Hant)
 * @property {TranslateRequestItem[]} items
 * @property {{ app_id?: string, request_id?: string }} [caller]
 *
 * @typedef {object} TranslateResponseItem
 * @property {string} id
 * @property {Record<string, { user_friendly_label?: string, description?: string }>} translations
 *
 * @typedef {object} TranslateResponse
 * @property {ModelRef} [model]
 * @property {TranslateResponseItem[]} items
 */

/**
 * @typedef {object} IdentifiedCondition
 * @property {string} [condition_id]
 * @property {string} category
 * @property {string} definition
 * @property {number} severity
 * @property {string} [severity_label]
 * @property {string} user_friendly_label
 * @property {string} description
 * @property {number[]} evidence_indices
 * @property {number} [confidence]
 * @property {ConditionTranslations} [translations]
 */

/**
 * Request metadata echoed back on the response. The service owns this shape; we
 * only read `position_descriptor` today, but the real response also carries the
 * report's timestamp and GPS (mirroring the required request metadata).
 * @typedef {object} AssessmentMetadata
 * @property {string} position_descriptor
 * @property {string} reported_at
 * @property {number} latitude
 * @property {number} longitude
 * @property {string} [notes]
 */

/**
 * @typedef {object} Assessment
 * @property {AssessmentMetadata} metadata
 * @property {GeneralConditions} general_conditions
 * @property {IdentifiedCondition[]} identified_conditions_of_concern
 */

/**
 * One stored input artifact (image or text) echoed back on the response,
 * pointing at where the service persisted it. We don't read these today.
 * @typedef {object} InputStorageItem
 * @property {number} index
 * @property {string} type
 * @property {string} content_type
 * @property {string} s3_uri
 */

/**
 * @typedef {object} AnalysisResponse
 * @property {string} analysis_id
 * @property {RubricRef} rubric
 * @property {string} created_at
 * @property {ModelRef} model
 * @property {{ app_id: string, request_id?: string }} [caller]
 * @property {InputStorageItem[]} [input_storage]
 * @property {Assessment} assessment
 * @property {{ s3_uri: string }} [result_storage]
 */

/** @type {string} */
export const RUBRIC_ID = "good-neighbor-app";

/** @type {string} */
export const RUBRIC_VERSION = "2.0.0";
