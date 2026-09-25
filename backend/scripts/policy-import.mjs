import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCatalog,
  validateCatalog,
} from "../src/analysis/guidance/rule-catalog.js";

function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const input = process.argv[2];
if (!input)
  throw new Error(
    "Usage: npm run policy:import -- /path/to/rules.csv [policy-version]",
  );
const rows = parseCsv(await readFile(resolve(input), "utf8"));
const header =
  rows.shift()?.map((value) => value.replace(/^\uFEFF/, "").trim()) ?? [];
if (
  header.length !== 17 ||
  header[13] !== "Max acceptable response time (hours)"
) {
  throw new Error(
    "Expected the 17-column GNP rulebase with Max acceptable response time (hours) in column 14",
  );
}
const catalog = buildCatalog({
  policyVersion:
    process.argv[3] || `import-${new Date().toISOString().slice(0, 10)}`,
  rows,
  aliases: [],
  metadata: { source: resolve(input), importedAt: new Date().toISOString() },
});
const validationErrors = validateCatalog(catalog);
if (validationErrors.length) throw new Error(validationErrors.join("\n"));
process.stdout.write(
  `${JSON.stringify({ policyVersion: catalog.policyVersion, rules: catalog.rules.length, catalog }, null, 2)}\n`,
);
