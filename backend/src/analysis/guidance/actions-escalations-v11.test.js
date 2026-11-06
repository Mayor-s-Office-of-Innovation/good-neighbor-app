import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";
import { evaluateCondition } from "./evaluator.js";

it("activates the 39 corrected source rules and preserves v10", () => {
  const imported = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/policy-import.mjs", import.meta.url),
        ),
        fileURLToPath(new URL("./sources/GNP-rules-v11.csv", import.meta.url)),
        "actions-escalations-v11",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(activeCatalog().policyVersion).toBe("actions-escalations-v11");
  expect(activeCatalog().rules).toHaveLength(39);
  expect(activeCatalog().rules).toEqual(imported.catalog.rules);
  for (const severity of [1, 2, 3]) {
    const condition = { category: "Someone in distress", severity };
    expect(
      evaluateCondition({ condition, answers: { affiliated: false } }),
    ).toMatchObject({
      kind: "outcome",
      rule: { ruleId: "DISTRESS-3" },
      outcome: {
        phoneNumber: "415-553-0123",
        buttons: ["Call SFPD"],
        guidance:
          "If it's not your client or resident, call the SFPD. Do not try to handle it yourself.",
      },
    });
    expect(
      evaluateCondition({
        condition,
        answers: { affiliated: false },
        catalog: catalogForPolicyVersion("actions-escalations-v10"),
      }),
    ).toMatchObject({ outcome: { phoneNumber: "911" } });
  }
});
