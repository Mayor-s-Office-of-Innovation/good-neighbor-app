#!/usr/bin/env node
/*
  Merge a flat JSON fragment of NEW English keys into every catalog.

    node scripts/i18n-merge.mjs path/to/fragment.json

  - en.json gets the English text; the other catalogs get the same English text
    as a placeholder (i18n-check reports it as untranslated) unless they already
    have a translation for that key.
  - Keys are kept sorted. A key that already exists with DIFFERENT English text
    is a hard error (two call sites disagree on the copy for one key).
  - Serialized with a lock directory so parallel extraction work cannot clobber
    the catalogs.
*/
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/catalogs",
);
const lock = join(dir, ".merge.lock");
const fragmentPath = process.argv[2];
if (!fragmentPath) throw new Error("Usage: i18n-merge.mjs <fragment.json>");
const fragment = JSON.parse(readFileSync(resolve(fragmentPath), "utf8"));
const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(fn) {
  for (let i = 0; i < 1200; i += 1) {
    try {
      mkdirSync(lock);
      try {
        return fn();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      await sleep(50);
    }
  }
  throw new Error("Could not acquire catalog lock");
}

await withLock(() => {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8"));
  const errors = [];
  for (const [key, text] of Object.entries(fragment)) {
    if (!KEY_RE.test(key)) errors.push(`bad key name: ${key}`);
    if (typeof text !== "string" || !text.trim())
      errors.push(`empty text: ${key}`);
    if (key in en && en[key] !== text) {
      errors.push(
        `conflict: "${key}" is already "${en[key]}", fragment says "${text}"`,
      );
    }
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  let added = 0;
  for (const file of files) {
    const path = join(dir, file);
    const catalog = JSON.parse(readFileSync(path, "utf8"));
    for (const [key, text] of Object.entries(fragment)) {
      if (!(key in catalog)) {
        catalog[key] = text;
        if (file === "en.json") added += 1;
      }
    }
    const sorted = Object.fromEntries(
      Object.keys(catalog)
        .sort()
        .map((k) => [k, catalog[k]]),
    );
    writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  }
  console.log(
    `merged ${Object.keys(fragment).length} keys (${added} new) into ${files.length} catalogs`,
  );
});
