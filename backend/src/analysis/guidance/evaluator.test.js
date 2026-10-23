import { describe, expect, it } from "vitest";
import { evaluateCondition, timeRangeMatches } from "./evaluator.js";
import { parseValidTimeRange } from "./rule-catalog.js";
import { actionsEscalationsV3Catalog } from "./actions-escalations-v3.js";
import { actionsEscalationsV4Catalog } from "./actions-escalations-v4.js";

describe("weekday-qualified Pacific time windows", () => {
  /**
   * @param {string} range
   * @param {string | undefined} reportedAt
   * @returns {boolean}
   */
  const matches = (range, reportedAt) =>
    timeRangeMatches(
      {
        ...actionsEscalationsV4Catalog.rules[0],
        validTimeRange: parseValidTimeRange(range),
      },
      reportedAt,
    );

  it.each([
    ["2026-10-09T14:59:00Z", false], // Friday 07:59 PDT
    ["2026-10-09T15:00:00Z", true],
    ["2026-10-10T00:00:59Z", true], // Friday 17:00 PDT, Saturday UTC
    ["2026-10-10T00:01:00Z", false],
    ["2026-10-10T15:00:00Z", false], // Saturday
    ["2026-10-11T15:00:00Z", false], // Sunday
    ["2026-10-12T15:00:00Z", true],
    ["2026-11-02T16:00:00Z", true], // Monday 08:00 PST after DST ends
    ["2026-03-09T15:00:00Z", true], // Monday 08:00 PDT after DST starts
  ])(
    "uses the report's local weekday and inclusive minute at %s",
    (reportedAt, expected) => {
      expect(matches("08:00-17:00, Mo+Tu+We+Th+Fr", reportedAt)).toBe(expected);
    },
  );

  it("keeps unqualified ranges active on weekends", () => {
    expect(matches("08:00-17:00", "2026-10-10T15:00:00Z")).toBe(true);
    expect(matches("24 hours", undefined)).toBe(true);
  });

  it("applies overnight qualifiers to the actual local calendar day", () => {
    expect(matches("17:01-07:59, Fr", "2026-10-10T06:59:00Z")).toBe(true);
    expect(matches("17:01-07:59, Fr", "2026-10-10T07:00:00Z")).toBe(false);
    expect(matches("17:01-07:59, Sa", "2026-10-10T07:00:00Z")).toBe(true);
    expect(matches("17:01-07:59, Sa", "2026-10-10T15:00:00Z")).toBe(false);
  });

  it("rejects missing or invalid timestamps for qualified ranges", () => {
    expect(matches("08:00-17:00, Mo", undefined)).toBe(false);
    expect(matches("08:00-17:00, Mo", "invalid")).toBe(false);
  });
});

/**
 * @param {string} category
 * @param {number} severity
 * @param {Record<string, unknown>} [answers]
 * @returns {ReturnType<typeof evaluateCondition>}
 */
const evalRule = (category, severity, answers = {}) =>
  evaluateCondition({
    condition: { category, severity },
    answers,
    catalog: actionsEscalationsV3Catalog,
  });

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
    ["Fire hazard", 2, {}, "FIRE-1", "escalation"],
    ["Fire hazard", 4, {}, "FIRE-2", "non_actionable_escalation"],
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
    [
      "Blocked doorway or sidewalk",
      3,
      {},
      "BLOCK-3",
      "non_actionable_escalation",
    ],
    ["Public drug use", 1, { affiliated: true }, "DRUG-1", "action"],
    [
      "Public drug use",
      1,
      { affiliated: false },
      "DRUG-2",
      "non_actionable_escalation",
    ],
    ["Public drug use", 3, {}, "DRUG-3", "non_actionable_escalation"],
    ["Public drug use", 4, {}, "DRUG-3", "non_actionable_escalation"],
    ["Someone in distress", 4, {}, "DISTRESS-1", "non_actionable_escalation"],
    ["Someone in distress", 3, { affiliated: true }, "DISTRESS-2", "action"],
    [
      "Someone in distress",
      3,
      { affiliated: false },
      "DISTRESS-3",
      "non_actionable_escalation",
    ],
    ["Aggressive animals", 2, { affiliated: true }, "ANIMAL-1", "action"],
    [
      "Aggressive animals",
      2,
      { affiliated: false },
      "ANIMAL-2",
      "non_actionable_escalation",
    ],
    ["Aggressive animals", 3, {}, "ANIMAL-3", "non_actionable_escalation"],
    [
      "Medical emergency",
      1,
      { medical_help: true },
      "MED-1",
      "non_actionable_escalation",
    ],
    ["Medical emergency", 1, { medical_help: false }, "MED-2", "action"],
    ["Medical emergency", 4, {}, "MED-3", "non_actionable_escalation"],
    [
      "Intimidation, or violence",
      1,
      { refusal_leave: true },
      "THREAT-1",
      "non_actionable_escalation",
    ],
    [
      "Intimidation, or violence",
      1,
      { refusal_leave: false },
      "THREAT-2",
      "action",
    ],
    [
      "Intimidation, or violence",
      3,
      {},
      "THREAT-3",
      "non_actionable_escalation",
    ],
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
    expect(
      evalRule("Large waste", 3, { provider_generated: false }),
    ).toMatchObject({
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
        buttons: ["We called 911"],
        appActions: [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "1.1.4.7.15.0",
              responsibleAgencyCode: "76",
              executionTrigger: "task_created",
            },
          },
        ],
      },
    });
  });
});

describe("time-valid v4 evaluation", () => {
  /**
   * @param {string} reportedAt
   * @returns {ReturnType<typeof evaluateCondition>}
   */
  const evaluateAnimal = (reportedAt) =>
    evaluateCondition({
      condition: { category: "Animals", severity: 2 },
      answers: { affiliated: false },
      catalog: actionsEscalationsV4Catalog,
      reportedAt,
    });

  it.each([
    ["2026-10-01T12:59:00.000Z", "ANIMAL-3"],
    ["2026-10-01T13:00:00.000Z", "ANIMAL-2"],
    ["2026-10-02T06:59:00.000Z", "ANIMAL-2"],
    ["2026-10-02T07:00:00.000Z", "ANIMAL-3"],
  ])("selects the Pacific-time rule at %s", (reportedAt, ruleId) => {
    expect(evaluateAnimal(reportedAt)).toMatchObject({
      kind: "outcome",
      rule: { ruleId },
    });
  });

  it("asks the clarifying question before applying its time split", () => {
    expect(
      evaluateCondition({
        condition: { category: "Animals", severity: 2 },
        catalog: actionsEscalationsV4Catalog,
        reportedAt: "2026-10-01T12:00:00.000Z",
      }),
    ).toMatchObject({
      kind: "needs_answer",
      question: { key: "affiliated" },
    });
  });
});
