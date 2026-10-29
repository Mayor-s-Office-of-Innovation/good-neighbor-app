import { expect, it } from "vitest";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";
import { evaluateCondition } from "./evaluator.js";
import { validateCatalog } from "./rule-catalog.js";

it("activates the supplied v9 rubric and preserves historical pickup behavior", () => {
  const catalog = activeCatalog();
  expect(catalog.policyVersion).toBe("actions-escalations-v9");
  expect(catalog.rules).toHaveLength(39);
  expect(validateCatalog(catalog)).toEqual([]);
  expect(
    evaluateCondition({
      condition: { category: "Bulky items", severity: 3 },
      answers: { provider_generated: true },
    }),
  ).toMatchObject({
    kind: "outcome",
    rule: { ruleId: "BULKY-1" },
    outcome: {
      kind: "non_actionable_escalation",
      phoneNumber: "415-330-1400",
      label: "Call Recology for pickup.",
    },
  });
  expect(
    catalogForPolicyVersion("actions-escalations-v8").rules.find(
      (rule) => rule.ruleId === "BULKY-1",
    )?.outcome.kind,
  ).toBe("action");
});

it.each([
  [true, "THREAT-2"],
  [false, "THREAT-1"],
])(
  "routes likely-to-leave answer %s using the supplied polarity",
  (answer, ruleId) => {
    const condition = {
      category: "Threats, intimidation, or violence",
      severity: 2,
    };
    expect(evaluateCondition({ condition })).toMatchObject({
      kind: "needs_answer",
      question: { key: "likely_to_leave" },
    });
    expect(
      evaluateCondition({ condition, answers: { likely_to_leave: answer } }),
    ).toMatchObject({ kind: "outcome", rule: { ruleId } });
    expect(
      catalogForPolicyVersion("actions-escalations-v8").rules.find(
        (rule) => rule.ruleId === "THREAT-1",
      )?.requiredQuestions[0].key,
    ).toBe("refusal_leave");
  },
);

it.each([1, 2, 3])("asks about medical help at severity %s", (severity) => {
  expect(
    evaluateCondition({
      condition: { category: "Medical emergency", severity },
    }),
  ).toMatchObject({ kind: "needs_answer", question: { key: "medical_help" } });
});
it.each([4, 5])(
  "routes severe medical emergencies directly to 911 at severity %s",
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
