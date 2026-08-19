import { pathToFileURL } from "node:url";
import { actionsEscalationsV2Catalog } from "../src/analysis/guidance/actions-escalations-v2.js";
import { rulebaseImpactFixtures } from "../src/analysis/guidance/fixtures/rulebase-impact-fixtures.js";
import {
  diffCatalogs,
  evaluateRulebaseImpact,
  summarizeRulebaseDiff,
} from "../src/analysis/guidance/rulebase-diff.js";
import { validateCatalog } from "../src/analysis/guidance/rule-catalog.js";

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * @param {string | boolean | undefined} value
 * @param {import("../src/analysis/guidance/rule-catalog.js").GuidanceCatalog} fallback
 * @returns {Promise<import("../src/analysis/guidance/rule-catalog.js").GuidanceCatalog>}
 */
async function loadCatalog(value, fallback) {
  if (!value || value === true) return fallback;
  const mod = await import(pathToFileURL(String(value)).href);
  const catalog =
    mod.catalog ?? mod.default ?? mod.actionsEscalationsV2Catalog ?? undefined;
  if (!catalog || typeof catalog !== "object") {
    throw new Error(`No guidance catalog export found in ${value}`);
  }
  return catalog;
}

const args = parseArgs(process.argv.slice(2));
const before = await loadCatalog(args.before, actionsEscalationsV2Catalog);
const after = await loadCatalog(args.after, actionsEscalationsV2Catalog);

const beforeErrors = validateCatalog(before);
const afterErrors = validateCatalog(after);
const diff = diffCatalogs(before, after);
const impact = evaluateRulebaseImpact(before, after, rulebaseImpactFixtures);

console.log(
  JSON.stringify(
    {
      before: before.policyVersion,
      after: after.policyVersion,
      ...summarizeRulebaseDiff(diff, impact),
      validation: {
        beforeErrors,
        afterErrors,
      },
      diff,
      impact,
    },
    null,
    2,
  ),
);

if (beforeErrors.length > 0 || afterErrors.length > 0) {
  process.exitCode = 1;
}
