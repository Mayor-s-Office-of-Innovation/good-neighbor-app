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
 * The active-locale translation of one analyzer field, or undefined when the
 * record has none (callers fall back to the canonical English field).
 * @param {{ translations?: unknown } | null | undefined} record a concern, condition, or task
 * @param {"user_friendly_label" | "description"} key
 * @returns {string | undefined}
 */
export function analyzerTranslation(record, key) {
  const translations = record?.translations;
  if (!translations || typeof translations !== "object") return undefined;
  const locale = getLocale();
  const map = /** @type {Record<string, unknown>} */ (translations);
  const entry =
    typeof map.language === "string"
      ? map.language === locale
        ? map
        : undefined
      : map[locale];
  if (!entry || typeof entry !== "object") return undefined;
  const text = /** @type {Record<string, unknown>} */ (entry)[key];
  return typeof text === "string" && text ? text : undefined;
}
