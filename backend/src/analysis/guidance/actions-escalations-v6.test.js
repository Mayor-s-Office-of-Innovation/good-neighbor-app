import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";
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
        fileURLToPath(new URL("./sources/GNP-rules-v6.csv", import.meta.url)),
        "actions-escalations-v6",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(activeCatalog().policyVersion).toBe("actions-escalations-v6");
  expect(activeCatalog().rules).toHaveLength(39);
  expect(activeCatalog().rules).toEqual(imported.catalog.rules);
  expect(validateCatalog(activeCatalog())).toEqual([]);
  expect(catalogForPolicyVersion("actions-escalations-v5").rules).toHaveLength(
    36,
  );
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
        catalog: activeCatalog(),
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
      catalog: activeCatalog(),
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
