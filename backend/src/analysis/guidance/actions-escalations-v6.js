import { ACTIONS_ESCALATIONS_V6_ROWS } from "./actions-escalations-v6.rows.js";
import { buildCatalog } from "./rule-catalog.js";

export const ACTIONS_ESCALATIONS_V6_POLICY_VERSION = "actions-escalations-v6";

export const actionsEscalationsV6Catalog = buildCatalog({
  policyVersion: ACTIONS_ESCALATIONS_V6_POLICY_VERSION,
  metadata: {
    sourceAsset: "GNP - rubrics-updated-2.csv",
    effectiveDate: "2026-10-08",
    createdAt: "2026-10-08T00:00:00.000Z",
    changelogPath: "docs/guidance-policy-changelog.md",
  },
  rows: ACTIONS_ESCALATIONS_V6_ROWS,
  // Older analysis results retain their original category text in storage.
  aliases: [
    { analyzerCategory: "Waste & Small Debris", canonicalCategory: "Litter" },
    { analyzerCategory: "Large waste", canonicalCategory: "Bulky items" },
    {
      analyzerCategory: "Temporary shelters",
      canonicalCategory: "Tents, tarps, or bedding",
    },
    {
      analyzerCategory: "Blocking access",
      canonicalCategory: "Blocked doorway or sidewalk",
    },
    {
      analyzerCategory: "Behavioral health",
      canonicalCategory: "Someone in distress",
    },
    { analyzerCategory: "Dangerous animals", canonicalCategory: "Animals" },
    { analyzerCategory: "Aggressive animals", canonicalCategory: "Animals" },
    {
      analyzerCategory: "Intimidation, or violence",
      canonicalCategory: "Threats, intimidation, or violence",
    },
    {
      analyzerCategory: "Intimidation or violence",
      canonicalCategory: "Threats, intimidation, or violence",
    },
    {
      analyzerCategory: "Intimidation and violence",
      canonicalCategory: "Threats, intimidation, or violence",
    },
  ],
});

export const catalog = actionsEscalationsV6Catalog;
