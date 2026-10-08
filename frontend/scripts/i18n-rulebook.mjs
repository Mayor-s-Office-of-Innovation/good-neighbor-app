#!/usr/bin/env node
/*
  Generate the `rulebook.*` and `server.*` catalog namespaces from the backend
  guidance catalog and the backend's other display tables, so rulebook text that reaches the UI as DATA on task items (label,
  guidance, button labels, cannot-do reasons, question prompts, categories,
  agencies) can be shown in the active language.

    node scripts/i18n-rulebook.mjs          # active policy version
    node scripts/i18n-rulebook.mjs --all    # every registered policy version

  Keys are content-addressed: `rulebook.<field>.<slug-of-english>-<hash4>`. No code references these keys; the
  frontend resolves a stored English string to its key through a reverse index
  built from en.json (frontend/src/i18n/rulebook.js). Identical text that
  appears in many rules ("File 311 ticket") is therefore one key, and changing
  a rule's English in the CSV yields a new key, which is exactly when a fresh
  translation is needed.

  The whole namespace is regenerated: keys no longer produced are removed from
  every catalog; new keys get the English text as placeholder in every catalog;
  existing translations for unchanged keys are kept.
*/
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../src/i18n/catalogs");
const registry = await import(
  "../../backend/src/analysis/guidance/catalog-registry.js"
);
const all = process.argv.includes("--all");

// Readable slug plus a short content hash: texts that differ only in
// punctuation ("…0123." vs "…0123") still get distinct, deterministic keys.
const slug = (text) => {
  const base = String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  const hash = createHash("sha1")
    .update(String(text))
    .digest("hex")
    .slice(0, 4);
  return `${base || "x"}-${hash}`;
};

/** @type {Record<string, string>} */
const generated = {};
const add = (field, text) => {
  const value = String(text ?? "").trim();
  if (!value) return;
  const key = `rulebook.${field}.${slug(value)}`;
  if (key in generated && generated[key] !== value) {
    throw new Error(
      `slug collision: ${key} for "${generated[key]}" and "${value}"`,
    );
  }
  generated[key] = value;
};

const catalogs = all
  ? [
      "actions-escalations-v2",
      "actions-escalations-v3",
      "actions-escalations-v4",
      "actions-escalations-v5",
      "actions-escalations-v6",
    ].map((v) => registry.catalogForPolicyVersion(v))
  : [registry.activeCatalog()];

for (const catalog of catalogs) {
  for (const rule of catalog.rules) {
    add("category", rule.category);
    add("agency", rule.primaryInProgressAgency);
    add("label", rule.outcome.label);
    add("guidance", rule.outcome.guidance);
    for (const b of rule.outcome.buttons) add("button", b);
    for (const r of rule.outcome.cannotDoReasons) add("cannotDo", r);
    for (const q of rule.requiredQuestions) {
      add("question", q.prompt);
      for (const o of q.options) add("option", o.label);
    }
  }
  for (const alias of catalog.aliases) add("category", alias.analyzerCategory);
}
// In-progress details synthesize "311" as the agency for filed tickets.
add("agency", "311");

// server.*: English the backend writes onto API responses outside the rulebook
// (311 status vocabulary, task-update timeline labels). Same lookup-by-text
// mechanism on the frontend; comparisons there still use the stored English.
const sf311 = await import("../../backend/src/integrations/sf311-status.js");
const taskUpdates = await import("../../backend/src/domain/task-updates.js");
const addServer = (field, table, { byName = false } = {}) => {
  for (const [name, text] of Object.entries(table)) {
    const value = String(text).trim();
    // Sentence templates are keyed by name so the frontend can address them
    // directly from an event's `kind`; plain vocabulary is content-addressed.
    const key = `server.${field}.${byName ? name : slug(value)}`;
    if (key in generated && generated[key] !== value) {
      throw new Error(`slug collision: ${key}`);
    }
    generated[key] = value;
  }
};
addServer("sf311.status", sf311.STATUS_NAMES);
addServer("sf311.priority", sf311.PRIORITY_NAMES);
addServer("sf311.closure", sf311.CLOSED_REASONS);
addServer("sf311.agency", sf311.AGENCY_NAMES);
addServer("sf311.eventTitle", sf311.EVENT_TITLES, { byName: true });
addServer("sf311.eventDescription", sf311.EVENT_DESCRIPTIONS, {
  byName: true,
});
addServer("sf311.detail", sf311.STATUS_DETAILS);
addServer("taskUpdate", taskUpdates.TASK_UPDATE_LABELS);

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
let removed = 0;
let added = 0;
for (const file of files) {
  const path = join(dir, file);
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  for (const key of Object.keys(catalog)) {
    if (
      (key.startsWith("rulebook.") || key.startsWith("server.")) &&
      !(key in generated)
    ) {
      delete catalog[key];
      if (file === "en.json") removed += 1;
    }
  }
  for (const [key, text] of Object.entries(generated)) {
    if (file === "en.json") {
      if (!(key in catalog)) added += 1;
      catalog[key] = text;
    } else if (!(key in catalog)) {
      catalog[key] = text;
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
  `rulebook: ${Object.keys(generated).length} keys from ${catalogs.length} policy version(s); +${added} new, -${removed} stale, across ${files.length} catalogs`,
);
