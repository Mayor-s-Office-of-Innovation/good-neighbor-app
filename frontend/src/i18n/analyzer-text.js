/*
  Localized analyzer text. The analysis service writes two fields per
  condition (`user_friendly_label`, `description`) and the backend stores
  translations of them as a per-locale map next to the English:

    translations: { es: { user_friendly_label, description }, vi: {…}, … }

  The capturing device's locale arrives with the analysis; the other locales
  are filled in by a background job a few seconds later. Records stored before
  the map existed hold a single block with a `language` field; both shapes are
  read here so the rest of the UI never looks inside `translations`.
*/
import { getLocale } from "./locale.js";

/**
 * One locale's entry from either stored shape, or undefined.
 * @param {unknown} translations
 * @param {string} locale
 * @returns {Record<string, unknown> | undefined}
 */
function entryFor(translations, locale) {
  if (!translations || typeof translations !== "object") return undefined;
  const map = /** @type {Record<string, unknown>} */ (translations);
  const entry =
    typeof map.language === "string"
      ? map.language === locale
        ? map
        : undefined
      : map[locale];
  return entry && typeof entry === "object"
    ? /** @type {Record<string, unknown>} */ (entry)
    : undefined;
}

/**
 * The active-locale translation of one analyzer field, or undefined when the
 * record has none (callers fall back to the canonical English field).
 * @param {{ translations?: unknown } | null | undefined} record a concern, condition, or task
 * @param {"user_friendly_label" | "description"} key
 * @returns {string | undefined}
 */
export function analyzerTranslation(record, key) {
  const text = entryFor(record?.translations, getLocale())?.[key];
  return typeof text === "string" && text ? text : undefined;
}

/**
 * Whether a record already holds both translated fields for a locale.
 * @param {{ translations?: unknown } | null | undefined} record
 * @param {string} locale
 * @returns {boolean}
 */
export function hasAnalyzerTranslation(record, locale) {
  const entry = entryFor(record?.translations, locale);
  return Boolean(
    entry &&
      typeof entry.user_friendly_label === "string" &&
      entry.user_friendly_label &&
      typeof entry.description === "string" &&
      entry.description,
  );
}
