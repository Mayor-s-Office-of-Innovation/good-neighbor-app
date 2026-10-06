#!/usr/bin/env node
/*
  Catalog guardrail. English (en.json) is the reference key set. For every other
  locale: no missing keys, no extra keys, identical {placeholder} sets, and a
  report of strings still identical to English (untranslated). Key names must
  follow the convention: lowerCamel segments joined by dots, at least two
  segments. Exit 1 on any hard failure; --strict also fails on untranslated.

    node scripts/i18n-check.mjs [--strict]
*/
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/catalogs",
);
const strict = process.argv.includes("--strict");
const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

const read = (file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const placeholders = (text) =>
  [...String(text).matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const en = read("en.json");
const enKeys = Object.keys(en);
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`✖ ${msg}`);
};

// Reference catalog hygiene.
for (const key of enKeys) {
  if (!KEY_RE.test(key)) fail(`en: key "${key}" breaks the naming convention`);
  if (typeof en[key] !== "string" || !en[key].trim())
    fail(`en: "${key}" is empty`);
}
const sorted = [...enKeys].sort();
if (enKeys.some((k, i) => k !== sorted[i])) fail("en: keys are not sorted");
for (const key of enKeys) {
  if (
    PLURAL_SUFFIX.test(key) &&
    !enKeys.includes(key.replace(PLURAL_SUFFIX, ".other"))
  ) {
    fail(`en: plural key "${key}" has no ".other" sibling`);
  }
}

for (const file of files) {
  if (file === "en.json") continue;
  const locale = file.replace(/\.json$/, "");
  const catalog = read(file);
  const keys = Object.keys(catalog);
  const missing = enKeys.filter((k) => !(k in catalog));
  const extra = keys.filter((k) => !(k in en));
  // Plural categories differ per language (zh/vi have only "other"), so a
  // locale may legitimately omit ".one" and may add ".few"/".many".
  const hardMissing = missing.filter(
    (k) => !PLURAL_SUFFIX.test(k) || k.endsWith(".other"),
  );
  const hardExtra = extra.filter((k) => !PLURAL_SUFFIX.test(k));
  for (const k of hardMissing) fail(`${locale}: missing "${k}"`);
  for (const k of hardExtra) fail(`${locale}: extra "${k}"`);
  for (const k of keys) {
    if (!(k in en)) continue;
    if (placeholders(en[k]) !== placeholders(catalog[k])) {
      fail(
        `${locale}: "${k}" placeholders differ from en ({${placeholders(en[k])}} vs {${placeholders(catalog[k])}})`,
      );
    }
  }
  const same = keys.filter((k) => k in en && catalog[k] === en[k]);
  const line = `${locale}: ${keys.length} keys, ${same.length} identical to English`;
  if (same.length && strict) fail(line);
  else console.log(`• ${line}`);
}

if (failures) {
  console.error(`\n${failures} problem(s).`);
  process.exit(1);
}
console.log(`✔ ${files.length} catalogs, ${enKeys.length} keys, consistent.`);
