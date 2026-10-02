/*
  Translate rulebook text that arrives as DATA on task items and assessment
  conditions: outcome labels, guidance, button labels, cannot-do reasons,
  clarifying-question prompts and options, categories, agencies — plus the
  backend's 311 vocabulary and timeline labels. The backend stores the English
  strings on each task (and the API uses some of them as identifiers, e.g. the
  cannot-do reason), so the UI keeps the stored English for anything it sends
  back and only translates what it displays.

  Lookup is by English text through a reverse index of the `rulebook.*` and
  `server.*` namespaces, which scripts/i18n-rulebook.mjs generates from the
  backend. The same English can exist under several keys ("Resolved" is both a
  311 closure reason and a task-update label) and translate differently by
  context, so callers that know their context pass a key-prefix `scope`.
  Text with no entry (older policy versions, free text) renders unchanged.
*/
import en from "./catalogs/en.json";
import { getLocale, getLocaleTag, t } from "./i18n.js";
import { DEFAULT_LOCALE } from "./locale.js";

/** @typedef {{ key: string, text: string }} Entry */

/** lower-cased English text → every generated key carrying that text */
/** @type {Map<string, Entry[]> | null} */
let index = null;

const isGenerated = (key) =>
  key.startsWith("rulebook.") || key.startsWith("server.");

function buildIndex() {
  const map = new Map();
  for (const [key, text] of Object.entries(en)) {
    if (!isGenerated(key)) continue;
    const fold = text.toLowerCase();
    if (!map.has(fold)) map.set(fold, []);
    map.get(fold).push({ key, text });
  }
  index = map;
  return map;
}

/**
 * @param {string} text
 * @param {string} [scope] key prefix to prefer, e.g. "server.sf311"
 * @returns {Entry | null}
 */
function find(text, scope) {
  const entries = (index ?? buildIndex()).get(text.trim().toLowerCase());
  if (!entries) return null;
  const exact = entries.filter((e) => e.text === text.trim());
  const pool = exact.length ? exact : entries;
  return (scope && pool.find((e) => e.key.startsWith(scope))) ?? pool[0];
}

/**
 * The catalog key for a stored rulebook / server string, or null when unknown.
 * @param {unknown} text
 * @param {string} [scope]
 * @returns {string | null}
 */
export function rulebookKey(text, scope) {
  if (typeof text !== "string") return null;
  return find(text, scope)?.key ?? null;
}

/**
 * Display form of a stored rulebook / server string in the active language.
 * Returns the input unchanged when it is not generated text (so it is safe to
 * wrap any backend-provided label with). A case-insensitive match keeps the
 * caller's casing: the backend lower-cases a closure reason inside
 * "Closed: resolved", and the translation is lower-cased to match.
 * @param {unknown} text
 * @param {string} [scope] key prefix to prefer when the English is ambiguous
 * @returns {string}
 */
export function rulebookText(text, scope) {
  if (typeof text !== "string" || !text) return "";
  if (getLocale() === DEFAULT_LOCALE) return text;
  const hit = find(text, scope);
  if (!hit) return text;
  const translated = t(hit.key);
  const folded = hit.text !== text.trim();
  return folded && text === text.toLowerCase()
    ? translated.toLocaleLowerCase(getLocaleTag())
    : translated;
}

/**
 * Label for a clarifying-question option ({ label, value }). Boolean options
 * map to the shared yes/no keys; anything else goes through rulebookText.
 * @param {{ label?: string, value?: unknown } | null | undefined} option
 * @returns {string}
 */
export function rulebookOptionLabel(option) {
  if (!option) return "";
  const label = typeof option.label === "string" ? option.label : "";
  return rulebookText(label, "rulebook.option") || String(option.value ?? "");
}
