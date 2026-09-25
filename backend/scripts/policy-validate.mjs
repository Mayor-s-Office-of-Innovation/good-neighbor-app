import { activeCatalog } from "../src/analysis/guidance/catalog-registry.js";
import { validateCatalog } from "../src/analysis/guidance/rule-catalog.js";

const catalog = activeCatalog();
const errors = validateCatalog(catalog);

const report = {
  policyVersion: catalog.policyVersion,
  metadata: catalog.metadata,
  ruleCount: catalog.rules.length,
  aliasCount: catalog.aliases.length,
  errors,
};

console.log(JSON.stringify(report, null, 2));

if (errors.length > 0) {
  process.exitCode = 1;
}
