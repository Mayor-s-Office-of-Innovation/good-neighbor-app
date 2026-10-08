import { getLocale } from "./locale.js";

/** Prefer an analyzer translation only when it matches the active locale.
 * @param {Record<string, any>} record
 * @param {string} flat
 * @param {string} translationsKey
 */
export function localizedAnalyzerText(record, flat, translationsKey) {
  const translations = record?.translations;
  if (translations && translations.language === getLocale()) {
    const localized = translations[translationsKey];
    if (typeof localized === "string" && localized) return localized;
  }
  return flat;
}
