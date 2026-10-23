// Localized copies of the two model-written analyzer fields
// (`user_friendly_label`, `description`), stored as a per-locale map on the
// ANALYSIS# concern and copied onto CONDITION# and TASK# items:
//
//   translations: { es: { user_friendly_label, description }, vi: {…}, … }
//
// The analyzer's analyze/edit calls still return ONE block for the requesting
// device's locale (`{ language, user_friendly_label, description }`); the
// background translate worker fills the remaining locales through the
// service's text-only `/v1/translations` endpoint. Everything that reads or
// writes the field goes through `normalizeTranslations`, which also upgrades
// records stored in the single-block shape before the map existed, so no
// backfill is needed and the frontend sees one shape.

/**
 * Locales the background job fills in, i.e. every supported UI language except
 * English (the canonical fields). Mirrors `frontend/src/i18n/locale.js`.
 * @type {readonly string[]}
 */
export const TRANSLATION_TARGET_LOCALES = Object.freeze([
  "es",
  "fil",
  "vi",
  "zh-Hant",
]);

/**
 * @typedef {object} TranslationEntry
 * @property {string} [user_friendly_label]
 * @property {string} [description]
 */

/** @typedef {Record<string, TranslationEntry>} TranslationsMap */

/**
 * @param {unknown} value
 * @returns {TranslationEntry | undefined}
 */
function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = /** @type {Record<string, unknown>} */ (value);
  /** @type {TranslationEntry} */
  const normalized = {};
  for (const key of /** @type {const} */ ([
    "user_friendly_label",
    "description",
  ])) {
    const text = entry[key];
    if (typeof text === "string" && text.trim()) normalized[key] = text.trim();
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Accept either shape and return the per-locale map, or undefined when nothing
 * usable survives. Malformed entries are dropped rather than rejected:
 * translations are display sugar, so bad input degrades to the canonical
 * English fields instead of failing the caller.
 *
 * - Legacy single block `{ language, user_friendly_label, description }` →
 *   `{ [language]: { user_friendly_label, description } }`.
 * - Map `{ [locale]: { user_friendly_label, description } }` → validated copy.
 * @param {unknown} value
 * @returns {TranslationsMap | undefined}
 */
export function normalizeTranslations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if ("language" in record) {
    const language = record.language;
    if (typeof language !== "string" || !language.trim()) return undefined;
    const entry = normalizeEntry(record);
    return entry ? { [language.trim()]: entry } : undefined;
  }
  /** @type {TranslationsMap} */
  const map = {};
  for (const [locale, entry] of Object.entries(record)) {
    if (!locale.trim()) continue;
    const normalized = normalizeEntry(entry);
    if (normalized) map[locale] = normalized;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Per-locale, per-field merge: an `incoming` field replaces the `prior` field
 * for the same locale, and fields or locales only one side has are kept. So a
 * later job that fills in a missing `description` never drops the
 * `user_friendly_label` already stored. Both inputs may be either shape.
 * @param {unknown} prior
 * @param {unknown} incoming
 * @returns {TranslationsMap | undefined}
 */
export function mergeTranslations(prior, incoming) {
  const base = normalizeTranslations(prior);
  const next = normalizeTranslations(incoming);
  if (!base) return next;
  if (!next) return base;
  /** @type {TranslationsMap} */
  const merged = { ...base };
  for (const [locale, entry] of Object.entries(next)) {
    merged[locale] = { ...base[locale], ...entry };
  }
  return merged;
}

/**
 * Whether a locale's entry carries BOTH translated fields. A half entry (the
 * service answered with only one field) still counts as missing, so a later
 * job asks for that locale again instead of leaving the other field English.
 * @param {TranslationEntry | undefined} entry
 * @returns {boolean}
 */
export function isCompleteTranslation(entry) {
  return Boolean(entry?.user_friendly_label && entry?.description);
}

/**
 * Locales from `targets` that `value` has no complete entry for.
 * @param {unknown} value
 * @param {readonly string[]} [targets]
 * @returns {string[]}
 */
export function missingTranslationLocales(
  value,
  targets = TRANSLATION_TARGET_LOCALES,
) {
  const map = normalizeTranslations(value) ?? {};
  return targets.filter((locale) => !isCompleteTranslation(map[locale]));
}

/**
 * Structural equality after normalization (key order independent).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function translationsEqual(a, b) {
  return (
    stableJson(normalizeTranslations(a)) ===
    stableJson(normalizeTranslations(b))
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value ?? null);
  const record = /** @type {Record<string, unknown>} */ (value);
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",") +
    "}"
  );
}
