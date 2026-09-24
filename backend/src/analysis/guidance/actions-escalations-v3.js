import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";

export const ACTIONS_ESCALATIONS_V3_POLICY_VERSION = "actions-escalations-v3";

/** @type {Record<string, number>} */
const RESPONSE_HOURS = {
  "ANIMAL-1": 1,
  "ANIMAL-2": 12,
  "ANIMAL-3": 0,
  "BLOCK-1": 4,
  "BLOCK-2": 4,
  "BLOCK-3": 4,
  "BULKY-1": 4,
  "BULKY-2": 4,
  "DISTRESS-1": 0,
  "DISTRESS-2": 1,
  "DISTRESS-3": 0,
  "DRUG-1": 4,
  "DRUG-2": 4,
  "DRUG-3": 4,
  "DRUG-4": 0,
  "FECES-1": 24,
  "FECES-2": 12,
  "FIRE-1": 12,
  "FIRE-2": 0,
  "GRAFFITI-1": 72,
  "GRAFFITI-2": 72,
  "GRAFFITI-3": 12,
  "GRAFFITI-4": 12,
  "LITTER-1": 48,
  "LITTER-2": 48,
  "MED-1": 0,
  "MED-2": 1,
  "MED-3": 0,
  "NEEDLES-1": 24,
  "TENTS-1": 96,
  "TENTS-2": 12,
  "THREAT-1": 4,
  "THREAT-2": 4,
  "THREAT-3": 0,
};

/** @type {Record<string, string>} */
const SERVICE_CODES = {
  "ANIMAL-1": "1.19.1.22.0.0",
  "ANIMAL-2": "1.19.1.22.0.0",
  "ANIMAL-3": "1.19.1.21.0.0",
  "BLOCK-1": "1.19.1.22.0.0",
  "BLOCK-3": "1.19.1.20.0.0",
  "BULKY-1": "1.19.1.22.0.0",
  "DISTRESS-1": "1.19.1.21.0.0",
  "DISTRESS-2": "1.19.1.22.0.0",
  "DISTRESS-3": "1.19.1.21.0.0",
  "DRUG-1": "1.19.1.22.0.0",
  "DRUG-2": "1.19.1.20.0.0",
  "DRUG-3": "1.19.1.20.0.0",
  "DRUG-4": "1.19.1.21.0.0",
  "FECES-2": "1.19.1.20.0.0",
  "GRAFFITI-3": "1.19.1.20.0.0",
  "GRAFFITI-4": "1.19.1.20.0.0",
  "MED-1": "1.19.1.21.0.0",
  "MED-2": "1.19.1.22.0.0",
  "MED-3": "1.19.1.21.0.0",
  "TENTS-2": "1.19.1.20.0.0",
  "THREAT-1": "1.19.1.21.0.0",
  "THREAT-2": "1.19.1.22.0.0",
  "THREAT-3": "1.19.1.21.0.0",
};

/** @param {import("./rule-catalog.js").GuidanceRule} rule */
function v3Rule(rule) {
  const serviceCode = SERVICE_CODES[rule.ruleId] ?? rule.outcome.category311;
  return {
    ...rule,
    policyVersion: ACTIONS_ESCALATIONS_V3_POLICY_VERSION,
    maxAcceptableResponseHours: RESPONSE_HOURS[rule.ruleId],
    category:
      rule.category === "Aggressive animals" ? "Animals" : rule.category,
    outcome: {
      ...rule.outcome,
      category311: serviceCode,
      appActions: rule.outcome.appActions.map((action) =>
        action.code === "create_311_ticket"
          ? {
              ...action,
              payload: {
                ...action.payload,
                serviceCodeOrAction: serviceCode,
              },
            }
          : action,
      ),
    },
  };
}

/** @type {import("./rule-catalog.js").GuidanceCatalog} */
export const actionsEscalationsV3Catalog = {
  policyVersion: ACTIONS_ESCALATIONS_V3_POLICY_VERSION,
  metadata: {
    sourceAsset: "GNP-3.csv",
    effectiveDate: "2026-09-23",
    createdAt: "2026-09-23T00:00:00.000Z",
    changelogPath: "docs/guidance-policy-changelog.md",
  },
  aliases: [
    ...actionsEscalationsV2Catalog.aliases.map((alias) => ({
      ...alias,
      canonicalCategory:
        alias.canonicalCategory === "Aggressive animals"
          ? "Animals"
          : alias.canonicalCategory,
    })),
    { analyzerCategory: "Aggressive animals", canonicalCategory: "Animals" },
  ],
  rules: actionsEscalationsV2Catalog.rules.map(v3Rule),
};

export const catalog = actionsEscalationsV3Catalog;
