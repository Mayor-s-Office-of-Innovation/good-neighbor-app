/*
  Translation lookup + locale switching.

  - English is imported statically so t() is synchronous and correct before any
    network round trip (and in node tests). The other catalogs are dynamic-import
    chunks, loaded on demand and cached; they live outside the main-bundle size
    budget.
  - Catalogs are flat { key: text }. Interpolation is {name}. Plural forms are
    sibling keys key.one / key.other (plus few/many where a language needs them),
    chosen by Intl.PluralRules from params.count.
  - A key missing from the active catalog falls back to English, then to the key
    itself with a one-time console warning.
  - setLocale() persists the choice, loads the catalog, registers the matching
    Web Awesome translation, sets <html lang>, and dispatches "localechange" on
    window; app-root re-renders on that event.
*/
import en from "./catalogs/en.json";
import {
  DEFAULT_LOCALE,
  getLocale,
  getLocaleTag,
  isLocale,
  readStoredLocale,
  setCurrentLocale,
  storeLocale,
} from "./locale.js";

export { getLocale, getLocaleTag, LOCALES } from "./locale.js";

/** @typedef {Record<string, string>} Catalog */

/** @type {Record<string, () => Promise<{ default: Catalog }>>} */
const loaders = {
  es: () => import("./catalogs/es.json"),
  fil: () => import("./catalogs/fil.json"),
  vi: () => import("./catalogs/vi.json"),
  "zh-Hant": () => import("./catalogs/zh-Hant.json"),
};

/**
 * Web Awesome's own control strings ("Clear entry", …). It ships es and zh-tw;
 * fil and vi fall back to its English. Its localize controller resolves
 * <html lang> by exact code, then by language subtag, so zh-tw is re-registered
 * under "zh-hant" to match our tag.
 * @type {Record<string, () => Promise<void>>}
 */
const waTranslations = {
  es: async () => {
    await import("@awesome.me/webawesome/dist/translations/es.js");
  },
  "zh-Hant": async () => {
    const [{ registerTranslation }, { default: zhTw }] = await Promise.all([
      import("@awesome.me/webawesome/dist/utilities/localize.js"),
      import("@awesome.me/webawesome/dist/translations/zh-tw.js"),
    ]);
    registerTranslation({ ...zhTw, $code: "zh-hant" });
  },
};

/** @type {Map<string, Catalog>} */
const catalogs = new Map([[DEFAULT_LOCALE, /** @type {Catalog} */ (en)]]);
/** @type {Set<string>} */
const warned = new Set();

/**
 * @param {string} id
 * @returns {Promise<Catalog>}
 */
async function loadCatalog(id) {
  const cached = catalogs.get(id);
  if (cached) return cached;
  const loader = loaders[id];
  if (!loader) return /** @type {Catalog} */ (en);
  const [{ default: catalog }] = await Promise.all([
    loader(),
    waTranslations[id]?.().catch(() => undefined),
  ]);
  catalogs.set(id, catalog);
  return catalog;
}

function setDocumentLang() {
  const root = globalThis.document?.documentElement;
  if (root) root.lang = getLocaleTag();
}

/** @param {string} id */
function applyToDocument(id) {
  const tag = getLocaleTag();
  setDocumentLang();
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("localechange", { detail: { locale: id, tag } }),
    );
  }
}

/**
 * Load a locale's catalog and make it current. Nothing changes until the
 * catalog is in hand, so a failed chunk load leaves the previous locale fully
 * intact. Resolves to whether the locale was activated.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function activate(id) {
  try {
    await loadCatalog(id);
  } catch {
    return false;
  }
  setCurrentLocale(id);
  return true;
}

/**
 * Switch the app's language: load the catalog, then persist the choice and
 * update the document. Resolves to false (and changes nothing) when the
 * catalog chunk cannot be loaded, e.g. offline on first use of a language.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function setLocale(id) {
  const next = isLocale(id) ? id : DEFAULT_LOCALE;
  if (!(await activate(next))) return false;
  storeLocale(next);
  applyToDocument(next);
  return true;
}

/**
 * Initial load of the stored locale. Started at import so app-root can simply
 * `await ready` before its first render. English resolves immediately; a
 * stored language whose chunk fails to load (offline first run) falls back to
 * English for this session without touching the stored preference.
 * @type {Promise<void>}
 */
export const ready = activate(readStoredLocale()).then((ok) => {
  if (!ok) setCurrentLocale(DEFAULT_LOCALE);
  setDocumentLang();
});

/** @type {Map<string, Intl.PluralRules>} */
const pluralRules = new Map();
/** @param {string} tag */
function rulesFor(tag) {
  let rules = pluralRules.get(tag);
  if (!rules) {
    rules = new Intl.PluralRules(tag);
    pluralRules.set(tag, rules);
  }
  return rules;
}

/**
 * @param {string} key
 * @param {Catalog} catalog
 * @param {number | undefined} count
 * @returns {string | undefined}
 */
function lookup(key, catalog, count) {
  if (count !== undefined) {
    // An untranslated entry is still English text, so it must follow English
    // plural rules: vi and zh-Hant have no "one" category and would otherwise
    // render "1 hours" from the ".other" placeholder.
    const untranslated =
      catalog !== en && catalog[`${key}.other`] === en[`${key}.other`];
    const tag = catalog === en || untranslated ? "en-US" : getLocaleTag();
    const category = rulesFor(tag).select(count);
    return (
      catalog[`${key}.${category}`] ?? catalog[`${key}.other`] ?? catalog[key]
    );
  }
  return catalog[key];
}

/**
 * Translate a key. `params.count` selects a plural form; every param is
 * available for `{name}` interpolation. Returns plain text: templates must
 * still escapeHtml / escapeAttr the result as they do for any string.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const count = typeof params?.count === "number" ? params.count : undefined;
  const active = catalogs.get(getLocale());
  let text = active ? lookup(key, active, count) : undefined;
  if (text === undefined)
    text = lookup(key, /** @type {Catalog} */ (en), count);
  if (text === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Whether the English catalog defines a key (the reference set).
 * @param {string} key
 * @returns {boolean}
 */
export function hasKey(key) {
  return key in en;
}
