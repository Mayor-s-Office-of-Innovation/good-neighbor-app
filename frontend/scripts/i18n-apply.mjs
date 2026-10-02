#!/usr/bin/env node
/*
  Apply translation overlays to one locale's catalog.

    node scripts/i18n-apply.mjs <locale> <overlay.json> [more.json ...]

  Each overlay is a flat { "key": "translated text" } file. Every key must
  exist in en.json, and the {placeholder} set must match English; violations
  abort before anything is written. Keys not covered by the overlays keep
  whatever the catalog already holds. Prints how many keys remain identical to
  English (untranslated) afterwards.
*/
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/catalogs",
);
const [locale, ...overlays] = process.argv.slice(2);
if (!locale || !overlays.length)
  throw new Error("Usage: i18n-apply.mjs <locale> <overlay.json...>");
if (locale === "en")
  throw new Error("Overlays apply to non-English catalogs only");

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const placeholders = (text) =>
  [...String(text).matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");
const en = read(join(dir, "en.json"));
const target = join(dir, `${locale}.json`);
const catalog = read(target);

const errors = [];
let applied = 0;
for (const file of overlays) {
  for (const [key, text] of Object.entries(read(resolve(file)))) {
    if (!(key in en)) {
      errors.push(`${file}: unknown key "${key}"`);
      continue;
    }
    if (typeof text !== "string" || !text.trim()) {
      errors.push(`${file}: empty "${key}"`);
      continue;
    }
    if (placeholders(en[key]) !== placeholders(text)) {
      errors.push(
        `${file}: placeholders differ for "${key}" ({${placeholders(en[key])}} vs {${placeholders(text)}})`,
      );
      continue;
    }
    catalog[key] = text;
    applied += 1;
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const sorted = Object.fromEntries(
  Object.keys(catalog)
    .sort()
    .map((k) => [k, catalog[k]]),
);
writeFileSync(target, JSON.stringify(sorted, null, 2) + "\n");
const same = Object.keys(en).filter((k) => sorted[k] === en[k]);
console.log(
  `${locale}: applied ${applied} keys; ${same.length} still identical to English`,
);
for (const k of same)
  console.log("  untranslated:", k, "=", JSON.stringify(en[k]));
