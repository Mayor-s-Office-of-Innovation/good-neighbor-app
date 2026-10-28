import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { catalogForPolicyVersion } from "./catalog-registry.js";
import { evaluateCondition } from "./evaluator.js";
import { validateCatalog } from "./rule-catalog.js";

it("activates all 39 supplied rules without changing their fields", () => {
  const imported = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/policy-import.mjs", import.meta.url),
        ),
        fileURLToPath(new URL("./sources/GNP-rules-v7.csv", import.meta.url)),
        "actions-escalations-v7",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(catalogForPolicyVersion("actions-escalations-v7").policyVersion).toBe(
    "actions-escalations-v7",
  );
  expect(catalogForPolicyVersion("actions-escalations-v7").rules).toHaveLength(
    39,
  );
  expect(catalogForPolicyVersion("actions-escalations-v7").rules).toEqual(
    imported.catalog.rules,
  );
  expect(
    validateCatalog(catalogForPolicyVersion("actions-escalations-v7")),
  ).toEqual([]);
  expect(catalogForPolicyVersion("actions-escalations-v5").rules).toHaveLength(
    36,
  );
});

it("rejects the retired 20-column import format", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../scripts/policy-import.mjs", import.meta.url),
      ),
      fileURLToPath(new URL("./sources/GNP-rules-v6.csv", import.meta.url)),
      "legacy-import",
    ],
    { encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Expected the 18-column GNP rulebase");
});

it.each([
  ["2026-10-09T14:59:00Z", 1, "FIRE-3"],
  ["2026-10-09T15:00:00Z", 1, "FIRE-1"],
  ["2026-10-10T00:00:00Z", 2, "FIRE-1"],
  ["2026-10-10T00:01:00Z", 2, "FIRE-3"],
  ["2026-10-10T15:00:00Z", 2, "FIRE-2"],
  ["2026-10-11T15:00:00Z", 1, "FIRE-2"],
  ["2026-10-12T15:00:00Z", 1, "FIRE-1"],
  ["2026-10-10T15:00:00Z", 3, "FIRE-4"],
  ["2026-10-11T07:00:00Z", 5, "FIRE-4"],
])(
  "routes fire at %s with severity %s to %s",
  (reportedAt, severity, ruleId) => {
    expect(
      evaluateCondition({
        condition: { category: "Fire hazard", severity },
        reportedAt,
        catalog: catalogForPolicyVersion("actions-escalations-v7"),
      }),
    ).toMatchObject({ kind: "outcome", rule: { ruleId } });
  },
);

it.each([
  ["Someone in distress", "Someone in distress", "DISTRESS-1"],
  ["Behavioral health", "Someone in distress", "DISTRESS-1"],
  [
    "Threats, intimidation, or violence",
    "Threats, intimidation, or violence",
    "THREAT-3",
  ],
  [
    "Intimidation and violence",
    "Threats, intimidation, or violence",
    "THREAT-3",
  ],
  [
    "Intimidation, or violence",
    "Threats, intimidation, or violence",
    "THREAT-3",
  ],
])("resolves current and historical category %s", (input, category, ruleId) => {
  expect(
    evaluateCondition({
      condition: { category: input, severity: 5 },
      catalog: catalogForPolicyVersion("actions-escalations-v7"),
    }),
  ).toMatchObject({ kind: "outcome", category, rule: { ruleId } });
});

it("keeps historical fire evaluations on their original policy", () => {
  expect(
    evaluateCondition({
      condition: { category: "Fire hazard", severity: 5 },
      catalog: catalogForPolicyVersion("actions-escalations-v5"),
    }),
  ).toMatchObject({
    kind: "outcome",
    rule: { ruleId: "FIRE-2" },
    outcome: { buttons: ["Call 911"] },
  });
});

it("derives filing triggers from action type and preserves explicit phone numbers", () => {
  const rules = catalogForPolicyVersion("actions-escalations-v7").rules;
  for (const rule of rules) {
    expect(rule.outcome.appActions).toHaveLength(1);
    expect(rule.outcome.appActions[0]).toMatchObject({
      code: "create_311_ticket",
      payload: {
        executionTrigger:
          rule.outcome.kind === "escalation"
            ? "user_confirmed"
            : "task_created",
      },
    });
    if (rule.outcome.kind === "non_actionable_escalation") {
      expect(rule.outcome.phoneNumber).toBeTruthy();
      expect(rule.canBeInProgress).toBe(true);
    }
  }
  expect(rules.find((r) => r.ruleId === "THREAT-1")?.outcome.phoneNumber).toBe(
    "415-553-0123",
  );
});
