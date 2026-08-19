import { actionsEscalationsV2Catalog } from "../src/analysis/guidance/actions-escalations-v2.js";
import { validateCatalog } from "../src/analysis/guidance/rule-catalog.js";

const errors = validateCatalog(actionsEscalationsV2Catalog);

const report = {
  policyVersion: actionsEscalationsV2Catalog.policyVersion,
  metadata: actionsEscalationsV2Catalog.metadata,
  ruleCount: actionsEscalationsV2Catalog.rules.length,
  aliasCount: actionsEscalationsV2Catalog.aliases.length,
  errors,
};

console.log(JSON.stringify(report, null, 2));

if (errors.length > 0) {
  process.exitCode = 1;
}
