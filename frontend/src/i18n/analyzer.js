import { analyzerTranslation } from "./analyzer-text.js";

/** Prefer an analyzer translation only when it matches the active locale.
 * @param {Record<string, any>} record
 * @param {string} flat
 * @param {"user_friendly_label" | "description"} translationsKey
 */
export function localizedAnalyzerText(record, flat, translationsKey) {
  return analyzerTranslation(record, translationsKey) ?? flat;
}
