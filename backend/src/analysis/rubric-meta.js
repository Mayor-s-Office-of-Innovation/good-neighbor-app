import { RUBRIC_VERSION } from "./contract.js";

// Versioned category metadata for the `good-neighbor-app` rubric. Copied from
// `../street-conditions-analysis/rubrics/good-neighbor-app-v1.json` (the id +
// weighting fields only — the stable surface; wording/severity guidance is
// CSV-generated and may churn, so we never depend on it here). Keyed by rubric
// version so a future version is an added entry, not a rewrite.
//
// `weighting` is the structural replacement for the removed `hazard_detected`
// flag: it is how the deferred escalation classifier will judge "how serious"
// a category is. The response returns a free-text `category`; we join back to
// this map (by label, then id) to recover the weighting.

/** @typedef {"Low" | "Moderate" | "High"} Weighting */

/**
 * @typedef {object} CategoryMeta
 * @property {string} id
 * @property {string} label
 * @property {Weighting} weighting
 */

/** @type {Record<string, CategoryMeta[]>} */
const CATEGORIES_BY_VERSION = {
  "1.0.0": [
    { id: "litter", label: "Litter", weighting: "Low" },
    { id: "large_waste", label: "Large waste", weighting: "Low" },
    { id: "feces_and_urine", label: "Feces and urine", weighting: "High" },
    { id: "needles", label: "Needles", weighting: "High" },
    { id: "temporary_shelters", label: "Temporary shelters", weighting: "High" },
    { id: "graffiti", label: "Graffiti", weighting: "Low" },
    { id: "fire_hazard", label: "Fire hazard", weighting: "High" },
    { id: "blocking_access", label: "Blocking access", weighting: "Moderate" },
    { id: "public_drug_use", label: "Public drug use", weighting: "Moderate" },
    { id: "behavioral_health", label: "Behavioral health", weighting: "High" },
    { id: "dangerous_animals", label: "Dangerous animals", weighting: "Moderate" },
    { id: "medical_emergency", label: "Medical emergency", weighting: "High" },
    {
      id: "intimidation_and_violence",
      label: "Intimidation and violence",
      weighting: "Moderate",
    },
  ],
};

/**
 * @param {string} [version]
 * @returns {CategoryMeta[]}
 */
export function categoriesFor(version = RUBRIC_VERSION) {
  return CATEGORIES_BY_VERSION[version] ?? [];
}

/**
 * @param {string} value
 * @returns {string}
 */
const normalize = (value) => value.trim().toLowerCase();

/**
 * @param {string} category
 * @param {string} [version]
 * @returns {Weighting | null}
 */
export function weightingFor(category, version = RUBRIC_VERSION) {
  if (typeof category !== "string") return null;
  const needle = normalize(category);
  const match = categoriesFor(version).find(
    (meta) => normalize(meta.label) === needle || normalize(meta.id) === needle,
  );
  return match ? match.weighting : null;
}
