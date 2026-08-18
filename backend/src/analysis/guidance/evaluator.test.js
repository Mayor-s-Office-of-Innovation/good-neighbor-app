import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./evaluator.js";

/**
 * @param {string} category
 * @param {number} severity
 * @param {Record<string, unknown>} [answers]
 * @returns {ReturnType<typeof evaluateCondition>}
 */
const evalRule = (category, severity, answers = {}) =>
  evaluateCondition({ condition: { category, severity }, answers });

describe("evaluateCondition", () => {
  it("returns no guidance for severity zero", () => {
    expect(evalRule("Litter", 0)).toEqual({
      kind: "no_guidance",
      category: "Litter",
      reason: "severity_zero",
    });
  });

  it("returns manual review for unresolved categories", () => {
    expect(evalRule("Something strange", 3)).toEqual({
      kind: "manual_review",
      category: "Something strange",
      reason: "unresolved_category",
    });
  });

  it("asks for the missing answer shared by candidate rules", () => {
    expect(evalRule("Bulky items", 3)).toMatchObject({
      kind: "needs_answer",
      category: "Bulky items",
      question: {
        key: "provider_generated",
        prompt: "Are these items from your site?",
        type: "boolean",
      },
      candidateRuleIds: ["BULKY-1", "BULKY-2"],
    });

    expect(evalRule("Graffiti", 2)).toMatchObject({
      kind: "needs_answer",
      category: "Graffiti",
      question: { key: "onsite" },
      candidateRuleIds: ["GRAFFITI-1", "GRAFFITI-2"],
    });
  });

  it.each([
    ["Litter", 1, {}, "LITTER-1", "action"],
    ["Litter", 3, {}, "LITTER-2", "escalation"],
    ["Bulky items", 3, { provider_generated: true }, "BULKY-1", "action"],
    ["Bulky items", 3, { provider_generated: false }, "BULKY-2", "escalation"],
    ["Feces and urine", 2, {}, "FECES-1", "escalation"],
    ["Needles", 1, {}, "NEEDLES-1", "escalation"],
    ["Tents, tarps, or bedding", 4, {}, "TENTS-1", "escalation"],
    ["Graffiti", 2, { onsite: true }, "GRAFFITI-1", "action"],
    ["Graffiti", 2, { onsite: false }, "GRAFFITI-2", "escalation"],
    ["Fire hazard", 3, {}, "FIRE-1", "escalation"],
    ["Fire hazard", 4, {}, "FIRE-2", "escalation"],
    [
      "Blocked doorway or sidewalk",
      2,
      { affiliated: true },
      "BLOCK-1",
      "action",
    ],
    [
      "Blocked doorway or sidewalk",
      2,
      { affiliated: false },
      "BLOCK-2",
      "escalation",
    ],
    ["Blocked doorway or sidewalk", 3, {}, "BLOCK-3", "escalation"],
    ["Public drug use", 3, { affiliated: true }, "DRUG-1", "action"],
    [
      "Public drug use",
      3,
      { affiliated: false },
      "DRUG-2",
      "escalation",
    ],
    ["Public drug use", 4, {}, "DRUG-3", "escalation"],
    ["Someone in distress", 4, {}, "DISTRESS-1", "escalation"],
    ["Someone in distress", 3, { affiliated: true }, "DISTRESS-2", "action"],
    [
      "Someone in distress",
      3,
      { affiliated: false },
      "DISTRESS-3",
      "escalation",
    ],
    ["Aggressive animals", 2, { affiliated: true }, "ANIMAL-1", "action"],
    [
      "Aggressive animals",
      2,
      { affiliated: false },
      "ANIMAL-2",
      "escalation",
    ],
    ["Aggressive animals", 3, {}, "ANIMAL-3", "escalation"],
    ["Medical emergency", 1, {}, "MED-1", "action"],
    ["Medical emergency", 2, {}, "MED-2", "escalation"],
    ["Intimidation, or violence", 1, {}, "THREAT-1", "escalation"],
  ])(
    "selects %s severity %i -> %s",
    (category, severity, answers, ruleId, kind) => {
      const result = evalRule(
        /** @type {string} */ (category),
        /** @type {number} */ (severity),
        /** @type {Record<string, unknown>} */ (answers),
      );

      expect(result).toMatchObject({
        kind: "outcome",
        rule: { ruleId },
        outcome: { kind },
      });
    },
  );

  it("evaluates analyzer aliases through the canonical rule category", () => {
    expect(evalRule("Large waste", 3, { provider_generated: false })).toMatchObject({
      kind: "outcome",
      category: "Bulky items",
      rule: { ruleId: "BULKY-2" },
    });
    expect(evalRule("Temporary shelters", 3)).toMatchObject({
      kind: "outcome",
      category: "Tents, tarps, or bedding",
      rule: { ruleId: "TENTS-1" },
    });
  });

  it("preserves executable outcome metadata", () => {
    expect(evalRule("Fire hazard", 5)).toMatchObject({
      kind: "outcome",
      rule: { ruleId: "FIRE-2" },
      outcome: {
        buttons: ["Call 911"],
        appActions: [{ code: "open_phone", payload: { phoneNumber: "911" } }],
      },
    });
  });
});
