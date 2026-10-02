#!/usr/bin/env node
/*
  Rename (or consolidate) catalog keys and update every call site.

    node scripts/i18n-rename.mjs old.key new.key [old.key2 new.key2 ...]

  For each pair: every `t("old.key"` / `"old.key"` reference under src/ becomes
  `new.key`; the old key is removed from all catalogs; if the new key does not
  exist yet it is created with the old key's text in every catalog (so a
  translation already made for the old key is carried over). If both exist, the
  English texts must match (then the old translations are dropped in favour of
  the new key's). Plural siblings (.one/.other/…) move together.
*/
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/i18n/catalogs");
const args = process.argv.slice(2);
if (!args.length || args.length % 2)
  throw new Error("Usage: i18n-rename.mjs old new [old new ...]");
const pairs = [];
for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const catalogs = Object.fromEntries(
  files.map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]),
);
const en = catalogs["en.json"];
const PLURAL = ["zero", "one", "two", "few", "many", "other"];

const expand = (oldKey, newKey) => {
  const out = [];
  if (oldKey in en) out.push([oldKey, newKey]);
  for (const p of PLURAL)
    if (`${oldKey}.${p}` in en) out.push([`${oldKey}.${p}`, `${newKey}.${p}`]);
  if (!out.length) throw new Error(`unknown key: ${oldKey}`);
  return out;
};
const moves = pairs.flatMap(([a, b]) => expand(a, b));
for (const [oldKey, newKey] of moves) {
  if (newKey in en && en[newKey] !== en[oldKey]) {
    throw new Error(
      `"${newKey}" exists with different English text than "${oldKey}"`,
    );
  }
}
for (const [file, catalog] of Object.entries(catalogs)) {
  for (const [oldKey, newKey] of moves) {
    if (!(newKey in catalog)) catalog[newKey] = catalog[oldKey];
    delete catalog[oldKey];
  }
  const sorted = Object.fromEntries(
    Object.keys(catalog)
      .sort()
      .map((k) => [k, catalog[k]]),
  );
  writeFileSync(join(dir, file), JSON.stringify(sorted, null, 2) + "\n");
}
const srcFiles = execSync("git ls-files src", { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.js$/.test(f) && !f.includes("/i18n/catalogs/"));
let edits = 0;
for (const rel of srcFiles) {
  const path = join(root, rel);
  let src = readFileSync(path, "utf8");
  const before = src;
  for (const [oldKey, newKey] of moves) {
    // References appear as string literals: "old.key" / 'old.key' / `old.key`.
    src = src
      .split(`"${oldKey}"`)
      .join(`"${newKey}"`)
      .split(`'${oldKey}'`)
      .join(`'${newKey}'`)
      .split("`" + oldKey + "`")
      .join("`" + newKey + "`");
  }
  if (src !== before) {
    writeFileSync(path, src);
    edits += 1;
  }
}
console.log(`moved ${moves.length} key(s); updated ${edits} source file(s)`);
for (const [a, b] of moves) console.log(`  ${a} -> ${b}`);
