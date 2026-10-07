import { actionsEscalationsV4Catalog } from "./actions-escalations-v4.js";
import { ACTIONS_ESCALATIONS_V5_ROWS } from "./actions-escalations-v5.rows.js";
import { buildCatalog } from "./rule-catalog.js";

export const ACTIONS_ESCALATIONS_V5_POLICY_VERSION = "actions-escalations-v5";

export const actionsEscalationsV5Catalog = buildCatalog({
  policyVersion: ACTIONS_ESCALATIONS_V5_POLICY_VERSION,
  metadata: {
    sourceAsset: "GNP rubrics.csv",
    effectiveDate: "2026-10-06",
    createdAt: "2026-10-06T00:00:00.000Z",
    changelogPath: "docs/guidance-policy-changelog.md",
  },
  rows: ACTIONS_ESCALATIONS_V5_ROWS,
  aliases: actionsEscalationsV4Catalog.aliases,
});

export const catalog = actionsEscalationsV5Catalog;
