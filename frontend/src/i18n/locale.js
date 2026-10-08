/*
  Locale state. Pure module: no DOM, no catalogs, so it is safe under node
  tests and can be imported by anything. The active locale id is persisted per
  device in localStorage (beside the theme override). Default is English; the
  app never auto-detects the browser language (decision 2026-10-02: start in
  en-US, switch explicitly from the settings menu).
*/

/**
 * @typedef {object} LocaleInfo
 * @property {string} id     catalog id, also the localStorage value
 * @property {string} tag    BCP 47 tag handed to Intl.* and <html lang>
 * @property {string} label  the language's own name, shown in the picker
 */

/** @type {readonly LocaleInfo[]} */
export const LOCALES = Object.freeze([
  { id: "en", tag: "en-US", label: "English" },
  { id: "es", tag: "es-US", label: "Español" },
  { id: "fil", tag: "fil-PH", label: "Filipino" },
  { id: "vi", tag: "vi-VN", label: "Tiếng Việt" },
  { id: "zh-Hant", tag: "zh-Hant", label: "繁體中文" },
]);

export const DEFAULT_LOCALE = "en";
const STORAGE_KEY = "locale";

let current = DEFAULT_LOCALE;

/**
 * @param {unknown} id
 * @returns {id is string}
 */
export function isLocale(id) {
  return typeof id === "string" && LOCALES.some((l) => l.id === id);
}

/** @returns {string} active locale id (e.g. "es") */
export function getLocale() {
  return current;
}

/** @returns {string} active BCP 47 tag for Intl formatting (e.g. "es-US") */
export function getLocaleTag() {
  return LOCALES.find((l) => l.id === current)?.tag ?? "en-US";
}

/**
 * Set the active locale id in memory only. i18n.js wraps this with catalog
 * loading and the DOM side effects; callers should use setLocale from there.
 * @param {string} id
 */
export function setCurrentLocale(id) {
  current = isLocale(id) ? id : DEFAULT_LOCALE;
}

/** @returns {string} the stored locale id, or the default when unset/invalid */
export function readStoredLocale() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** @param {string} id */
export function storeLocale(id) {
  try {
    if (id === DEFAULT_LOCALE) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode / storage blocked: the choice lasts for this load only */
  }
}
