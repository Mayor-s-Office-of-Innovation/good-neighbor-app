import { actionsEscalationsV3Catalog } from "./actions-escalations-v3.js";
import { ACTIONS_ESCALATIONS_V4_ROWS } from "./actions-escalations-v4.rows.js";
import { buildCatalog } from "./rule-catalog.js";

export const ACTIONS_ESCALATIONS_V4_POLICY_VERSION = "actions-escalations-v4";

export const actionsEscalationsV4Catalog = buildCatalog({
  policyVersion: ACTIONS_ESCALATIONS_V4_POLICY_VERSION,
  metadata: {
    sourceAsset: "GNP rubrics-2.csv",
    effectiveDate: "2026-10-01",
    createdAt: "2026-10-01T00:00:00.000Z",
    changelogPath: "docs/guidance-policy-changelog.md",
  },
  rows: ACTIONS_ESCALATIONS_V4_ROWS,
  aliases: actionsEscalationsV3Catalog.aliases,
});

export const catalog = actionsEscalationsV4Catalog;
