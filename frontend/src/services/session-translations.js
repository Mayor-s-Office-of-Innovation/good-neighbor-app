/*
  Pull background translations into the capture session.

  The analysis a card is built from is fetched once, as soon as it lands, and
  then lives in session state; the backend's translate worker fills the other
  locales into DynamoDB a few seconds later, which the session never sees. A
  language switch re-renders from that stale copy and the cards would stay
  English. This refetches the check once per switch (and once more shortly
  after, in case the worker is still running) and merges any new locale maps
  into the session's concerns, conditions, and tasks by exact English text —
  the same matching the worker uses, so every copy converges to one map.
*/
import { getCheck } from "./api.js";
import { getCurrentCheck, updateItemAnalysis } from "../state/check-session.js";
import { getLocale, DEFAULT_LOCALE } from "../i18n/locale.js";
import { hasAnalyzerTranslation } from "../i18n/analyzer-text.js";

/** Second look after the first fetch, in case the worker was still running. */
export const RETRY_DELAY_MS = 8000;

/**
 * @param {Record<string, any> | undefined} record
 * @returns {string}
 */
const textKey = (record) =>
  JSON.stringify([
    String(record?.userFriendlyLabel ?? "").trim(),
    String(record?.description ?? record?.explanation ?? "").trim(),
  ]);

/**
 * Per-locale map from either stored shape.
 * @param {unknown} translations
 * @returns {Record<string, Record<string, string>>}
 */
function toMap(translations) {
  if (!translations || typeof translations !== "object") return {};
  const value = /** @type {Record<string, any>} */ (translations);
  if (typeof value.language === "string") {
    const { language, ...entry } = value;
    return { [language]: entry };
  }
  return value;
}

/**
 * @param {unknown} prior
 * @param {unknown} incoming
 * @returns {Record<string, Record<string, string>>}
 */
function merge(prior, incoming) {
  const base = toMap(prior);
  const merged = { ...base };
  for (const [locale, entry] of Object.entries(toMap(incoming))) {
    merged[locale] = { ...base[locale], ...entry };
  }
  return merged;
}

/**
 * Records whose text still lacks a complete entry for `locale`.
 * @param {Record<string, any>[]} records
 * @param {string} locale
 * @returns {boolean}
 */
const anyMissing = (records, locale) =>
  records.some(
    (record) =>
      record &&
      (record.userFriendlyLabel || record.description || record.explanation) &&
      !hasAnalyzerTranslation(record, locale),
  );

/**
 * @param {Record<string, any>} item a session item
 * @returns {Record<string, any>[]}
 */
const recordsOf = (item) => [
  ...(item.analysis?.sourceAnalysis?.concerns || []),
  ...(item.analysis?.conditions || []),
  ...(item.analysis?.tasks || []),
];

/**
 * Refetch the current check and merge any translations the backend has since
 * filled in. Returns true when every analyzed record now has `locale`, false
 * when something is still missing (including when the fetch failed), so the
 * caller can decide to look again. English needs nothing and returns true.
 * @param {{ locale?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function refreshSessionTranslations({
  locale = getLocale(),
} = {}) {
  const check = getCurrentCheck();
  if (!check?.id || locale === DEFAULT_LOCALE) return true;
  const stale = (check.items || []).filter(
    (item) =>
      item.analysis?.status === "analyzed" &&
      anyMissing(recordsOf(item), locale),
  );
  if (stale.length === 0) return true;

  let remote;
  try {
    remote = await getCheck(check.id);
  } catch {
    return false; // offline or transient: the English fallback stays
  }
  if (getCurrentCheck()?.id !== check.id) return true;

  /** @type {Map<string, unknown>} */
  const byText = new Map();
  for (const analysis of remote?.analyses || []) {
    for (const concern of analysis?.concerns || []) {
      if (concern?.translations)
        byText.set(textKey(concern), concern.translations);
    }
  }

  let complete = true;
  for (const item of stale) {
    let changed = false;
    /** @param {Record<string, any>[]} records */
    const patched = (records) =>
      records.map((record) => {
        const incoming = byText.get(textKey(record));
        if (!incoming) return record;
        const next = merge(record.translations, incoming);
        if (JSON.stringify(next) === JSON.stringify(toMap(record.translations)))
          return record;
        changed = true;
        return { ...record, translations: next };
      });
    const sourceAnalysis = item.analysis?.sourceAnalysis;
    const patch = {
      ...(sourceAnalysis?.concerns
        ? {
            sourceAnalysis: {
              ...sourceAnalysis,
              concerns: patched(sourceAnalysis.concerns),
            },
          }
        : {}),
      ...(item.analysis?.conditions
        ? { conditions: patched(item.analysis.conditions) }
        : {}),
      ...(item.analysis?.tasks ? { tasks: patched(item.analysis.tasks) } : {}),
    };
    if (changed) updateItemAnalysis(item.id, patch);
    const now = /** @type {Record<string, any>[]} */ ([
      ...(patch.sourceAnalysis?.concerns || []),
      ...(patch.conditions || []),
      ...(patch.tasks || []),
    ]);
    if (anyMissing(now, locale)) complete = false;
  }
  return complete;
}

/**
 * Locale-switch hook: refresh now and, if the worker has not finished, once
 * more after a short delay. Never throws; the English fallback is the floor.
 * @param {{ locale?: string, retryDelayMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function refreshSessionTranslationsOnLocaleChange({
  locale = getLocale(),
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  if (await refreshSessionTranslations({ locale })) return;
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  if (getLocale() !== locale) return;
  await refreshSessionTranslations({ locale });
}
