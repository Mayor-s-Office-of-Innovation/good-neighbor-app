import { describe, expect, it } from "vitest";
import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";
import {
  diffCatalogs,
  evaluateRulebaseImpact,
  summarizeRulebaseDiff,
} from "./rulebase-diff.js";

/**
 * @param {(rule: any) => any} mapRule
 * @returns {import("./rule-catalog.js").GuidanceCatalog}
 */
function catalogVariant(mapRule) {
  return {
    ...actionsEscalationsV2Catalog,
    policyVersion: "actions-escalations-test",
    metadata: {
      ...actionsEscalationsV2Catalog.metadata,
      sourceAsset: "test.csv",
    },
    rules: actionsEscalationsV2Catalog.rules.map((rule) =>
      mapRule({ ...rule }),
    ),
  };
}

describe("rulebase semantic diff", () => {
  it("reports metadata, routing, user-facing, and integration changes", () => {
    const after = catalogVariant((rule) => {
      if (rule.ruleId !== "LITTER-2") return rule;
      return {
        ...rule,
        severity: { min: 4, max: 5 },
        outcome: {
          ...rule.outcome,
          label: "Ask the City to clean up larger trash.",
          category311: "Street Cleaning",
          appActions: [
            {
              code: "create_311_ticket",
              payload: { category311: "Street Cleaning" },
            },
          ],
        },
      };
    });

    const diff = diffCatalogs(actionsEscalationsV2Catalog, after);

    expect(diff.metadataChanges.map((change) => change.path)).toEqual([
      "policyVersion",
      "metadata",
    ]);
    expect(diff.changedRules).toEqual([
      {
        ruleId: "LITTER-2",
        category: "Litter",
        changes: expect.arrayContaining([
          expect.objectContaining({ path: "severity", impact: "routing" }),
          expect.objectContaining({
            path: "outcome.label",
            impact: "user_experience",
          }),
          expect.objectContaining({
            path: "outcome.appActions",
            impact: "integration",
          }),
          expect.objectContaining({
            path: "outcome.category311",
            impact: "integration",
          }),
        ]),
      },
    ]);
  });

  it("reports fixture-level behavior changes", () => {
    const after = catalogVariant((rule) => {
      if (rule.ruleId !== "LITTER-2") return rule;
      return { ...rule, severity: { min: 4, max: 5 } };
    });

    const impact = evaluateRulebaseImpact(actionsEscalationsV2Catalog, after, [
      {
        id: "litter-severity-3",
        condition: { category: "Litter", severity: 3 },
      },
      {
        id: "litter-severity-4",
        condition: { category: "Litter", severity: 4 },
      },
    ]);

    expect(impact).toEqual([
      {
        fixtureId: "litter-severity-3",
        before: expect.objectContaining({
          kind: "outcome",
          ruleId: "LITTER-2",
        }),
        after: {
          kind: "manual_review",
          reason: "no_matching_rule",
          category: "Litter",
        },
      },
    ]);

    const summary = summarizeRulebaseDiff(
      diffCatalogs(actionsEscalationsV2Catalog, after),
      impact,
    );
    expect(summary.summary).toMatchObject({
      changedRules: 1,
      routingChanges: 1,
      fixtureOutcomeChanges: 1,
    });
  });
});
