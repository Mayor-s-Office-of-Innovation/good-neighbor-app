/*
  English catalog access for the e2e suite. Specs locate by stable hooks (ids,
  data attributes, roles) and, where visible or accessible text matters, assert
  through the same catalog the app renders from — so copy edits never break a
  locator and the accessible-name checks keep their teeth.

  `t` mirrors the app's lookup (frontend/src/i18n/i18n.js): `{name}`
  interpolation and `.one` / `.other` plural selection from `params.count`.
  Unlike the app, an unknown key throws: a test should never silently match
  a key string.
*/
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {Record<string, string>} */
const en = require("../../frontend/src/i18n/catalogs/en.json");
const plural = new Intl.PluralRules("en-US");

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  let text = en[key];
  if (text === undefined && typeof params?.count === "number") {
    text = en[`${key}.${plural.select(params.count)}`] ?? en[`${key}.other`];
  }
  if (text === undefined) throw new Error(`e2e i18n: unknown key "${key}"`);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * A RegExp that matches a templated message with any value in each
 * placeholder, for assertions like "From today's {time} check" where the
 * value is not known to the test.
 * @param {string} key
 * @returns {RegExp}
 */
export function tPattern(key) {
  const source = t(key)
    .split(/\{\w+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+?");
  return new RegExp(source);
}
