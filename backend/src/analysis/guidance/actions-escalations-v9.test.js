import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";
import { evaluateCondition } from "./evaluator.js";
import { validateCatalog } from "./rule-catalog.js";

it("activates all 39 final CSV rules without changing their fields", () => {
  const imported = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/policy-import.mjs", import.meta.url),
        ),
        fileURLToPath(new URL("./sources/GNP-rules-v9.csv", import.meta.url)),
        "actions-escalations-v9",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(activeCatalog().policyVersion).toBe("actions-escalations-v9");
  expect(activeCatalog().rules).toHaveLength(39);
  expect(activeCatalog().rules).toEqual(imported.catalog.rules);
  expect(validateCatalog(activeCatalog())).toEqual([]);
});

it.each([1, 2])(
  "routes both threat answers correctly at severity %s",
  (severity) => {
    const condition = {
      category: "Threats, intimidation, or violence",
      severity,
    };
    expect(evaluateCondition({ condition })).toMatchObject({
      kind: "needs_answer",
      question: { key: "likely_to_leave", type: "boolean" },
    });
    expect(
      evaluateCondition({ condition, answers: { likely_to_leave: true } }),
    ).toMatchObject({
      kind: "outcome",
      rule: { ruleId: "THREAT-2" },
      outcome: { kind: "action", buttons: ["Ask them to leave"] },
    });
    expect(
      evaluateCondition({ condition, answers: { likely_to_leave: false } }),
    ).toMatchObject({
      kind: "outcome",
      rule: { ruleId: "THREAT-1" },
      outcome: { phoneNumber: "415-553-0123" },
    });
    // An old answer must not silently satisfy the renamed question.
    expect(
      evaluateCondition({ condition, answers: { refusal_leave: true } }),
    ).toMatchObject({
      kind: "needs_answer",
      question: { key: "likely_to_leave" },
    });
  },
);

it.each(["v2", "v3", "v4", "v5", "v6", "v7", "v8"])(
  "preserves the stored threat answer contract for %s",
  (version) => {
    const catalog = catalogForPolicyVersion(`actions-escalations-${version}`);
    const category = catalog.rules.find(
      (rule) => rule.ruleId === "THREAT-1",
    )?.category;
    if (!category) throw new Error("Missing historical threat category");
    const condition = { category, severity: 1 };
    expect(evaluateCondition({ condition, catalog })).toMatchObject({
      kind: "needs_answer",
      question: { key: "refusal_leave" },
    });
    for (const answer of [true, false]) {
      expect(
        evaluateCondition({
          condition,
          catalog,
          answers: { refusal_leave: answer },
        }),
      ).toMatchObject({
        kind: "outcome",
        rule: { ruleId: answer ? "THREAT-1" : "THREAT-2" },
      });
    }
  },
);

it.each([1, 2, 3])("asks about medical help at severity %s", (severity) => {
  const condition = { category: "Medical emergency", severity };
  expect(evaluateCondition({ condition })).toMatchObject({
    kind: "needs_answer",
    question: { key: "medical_help" },
  });
  for (const answer of [true, false]) {
    expect(
      evaluateCondition({ condition, answers: { medical_help: answer } }),
    ).toMatchObject({
      kind: "outcome",
      rule: { ruleId: answer ? "MED-1" : "MED-2" },
    });
  }
});

it.each([4, 5])(
  "routes medical severity %s to 911 without a question",
  (severity) => {
    expect(
      evaluateCondition({
        condition: { category: "Medical emergency", severity },
      }),
    ).toMatchObject({
      kind: "outcome",
      rule: { ruleId: "MED-3" },
      outcome: { phoneNumber: "911" },
    });
  },
);
