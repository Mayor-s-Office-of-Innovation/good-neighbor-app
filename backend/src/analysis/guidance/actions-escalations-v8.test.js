import { expect, it } from "vitest";
import { catalogForPolicyVersion } from "./catalog-registry.js";
import { validateCatalog } from "./rule-catalog.js";

it("preserves v8 with only the nine supplied button-label changes", () => {
  const catalog = catalogForPolicyVersion("actions-escalations-v8");
  expect(catalog.policyVersion).toBe("actions-escalations-v8");
  expect(validateCatalog(catalog)).toEqual([]);
  const previous = catalogForPolicyVersion("actions-escalations-v7");
  expect(catalog.rules).toHaveLength(39);
  let changed = 0;
  for (const rule of catalog.rules) {
    const old = previous.rules.find(
      (candidate) => candidate.ruleId === rule.ruleId,
    );
    if (!old) throw new Error(`Missing historical rule ${rule.ruleId}`);
    const expectedButtons = old.outcome.buttons.map((label) =>
      label.replace(/: \d{3}-\d{3}-\d{4}$/, ""),
    );
    if (JSON.stringify(expectedButtons) !== JSON.stringify(old.outcome.buttons))
      changed++;
    expect(rule).toEqual({
      ...old,
      policyVersion: catalog.policyVersion,
      outcome: { ...old.outcome, buttons: expectedButtons },
    });
  }
  expect(changed).toBe(9);
});
