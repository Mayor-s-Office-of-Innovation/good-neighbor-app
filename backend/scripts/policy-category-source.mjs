// Regenerate the bundled recognition seed after updating the reviewed source CSV.
// It is intentionally separate from action rules, which always use activeCatalog().
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { readPolicyCsv } from "../src/analysis/guidance/policy-csv.js";
const source = new URL(
  "../src/analysis/guidance/sources/GNP-categories-v2.csv",
  import.meta.url,
);
const target = new URL(
  "../src/analysis/guidance/policy-category-source.js",
  import.meta.url,
);
const rows = readPolicyCsv(await readFile(source, "utf8")).slice(1);
await writeFile(
  target,
  await format(
    `// Recognition guidance from sources/GNP-categories-v2.csv. Rules are seeded from activeCatalog().\nexport const POLICY_CATEGORY_SOURCE = ${JSON.stringify(rows)};\n`,
    { parser: "babel" },
  ),
);
