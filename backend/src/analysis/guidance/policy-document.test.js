import { readFileSync } from "node:fs";
import { POLICY_CATEGORY_SOURCE } from "./policy-category-source.js";
import { describe, expect, it } from "vitest";
import {
  compilePolicy,
  isPolicyDocument,
  policyTexts,
  validatePolicy,
} from "./policy-document.js";
import { evaluateCondition } from "./evaluator.js";
import {
  initialPolicyDocument,
  importPolicyCsv,
  exportPolicyCsv,
} from "./policy-import.js";
import { readPolicyCsv, writePolicyCsv } from "./policy-csv.js";
import { activeCatalog } from "./catalog-registry.js";

/** Synthetic authoring fixture with no real incident or person data.
 * @returns {import('./policy-document.js').PolicyDocument}
 */
export function examplePolicy() {
  return {
    schemaVersion: 1,
    baseVersion: "test",
    categories: [
      {
        id: "example",
        name: "Example category",
        weighting: "Low",
        definition: "Example definition",
        includes: "Example items",
        excludes: "Other items",
        visualCues: "Visible example",
        descriptionGuidance: "Describe what is visible",
        severityGuidance: Array.from(
          { length: 6 },
          (_, i) => `Example level ${i}`,
        ),
        aliases: [],
      },
    ],
    questions: [],
    rules: [
      {
        id: "EXAMPLE-1",
        categoryId: "example",
        severityMin: 1,
        severityMax: 5,
        order: 1,
        schedule: {
          always: true,
          start: 0,
          end: 1439,
          days: [0, 1, 2, 3, 4, 5, 6],
        },
        questionId: "",
        answer: true,
        actionType: "site",
        label: "Handle the example",
        button: "Handle example",
        guidance: "Example guidance",
        phone: "",
        routing: "",
        agencyCode: "",
        agency: "Example agency",
        inProgress: false,
        responseHours: 4,
        overrides: [],
      },
    ],
    translations: {},
  };
}

describe("policy editor validation", () => {
  it("produces a working example for a complete policy and treats zero as no concern", () => {
    const d = examplePolicy(),
      report = validatePolicy(d);
    expect(isPolicyDocument(d)).toBe(true);
    expect(report.valid).toBe(true);
    expect(report.witnesses["EXAMPLE-1"]).toMatchObject({ severity: 1 });
    expect(
      evaluateCondition({
        condition: { category: "Example category", severity: 0 },
        catalog: compilePolicy(d),
      }).kind,
    ).toBe("no_guidance");
  });
  it("detects complete shadowing even when coverage has no gaps", () => {
    const d = examplePolicy();
    d.rules.push({ ...structuredClone(d.rules[0]), id: "EXAMPLE-2", order: 2 });
    expect(validatePolicy(d).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unreachable", ruleId: "EXAMPLE-2" }),
        expect.objectContaining({ code: "overlap" }),
      ]),
    );
  });
  it("allows explicit partial exceptions while requiring every rule to remain reachable", () => {
    const d = examplePolicy();
    d.rules[0].order = 2;
    d.rules.push({
      ...structuredClone(d.rules[0]),
      id: "EXAMPLE-2",
      order: 1,
      severityMin: 5,
      overrides: ["EXAMPLE-1"],
    });
    expect(validatePolicy(d).valid).toBe(true);
    d.rules[1].severityMin = 1;
    expect(validatePolicy(d).issues).toContainEqual(
      expect.objectContaining({ code: "unreachable", ruleId: "EXAMPLE-1" }),
    );
  });
  it("finds a one-minute weekly gap and accepts complementary overnight schedules", () => {
    const d = examplePolicy();
    d.rules[0].schedule = {
      always: false,
      start: 540,
      end: 1020,
      days: [0, 1, 2, 3, 4, 5, 6],
    };
    d.rules.push({
      ...structuredClone(d.rules[0]),
      id: "EXAMPLE-2",
      schedule: {
        always: false,
        start: 1021,
        end: 539,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    expect(validatePolicy(d).valid).toBe(true);
    d.rules[1].schedule.days = [0, 1, 2, 3, 4, 5];
    expect(validatePolicy(d).issues).toContainEqual(
      expect.objectContaining({
        code: "coverageGap",
        scenario: expect.objectContaining({ day: 6, minute: 0 }),
      }),
    );
    d.rules[1].schedule.days = [0, 1, 2, 3, 4, 5, 6];
    d.rules[1].schedule.start = 1022;
    expect(validatePolicy(d).issues).toContainEqual(
      expect.objectContaining({
        code: "coverageGap",
        scenario: expect.objectContaining({ minute: 1021 }),
      }),
    );
  });
  it("checks both answer branches and preserves behavior when question wording changes", () => {
    const d = examplePolicy();
    d.questions = [{ id: "example_question", prompt: "Does this apply?" }];
    d.rules[0].questionId = "example_question";
    expect(validatePolicy(d).issues.some((i) => i.code === "coverageGap")).toBe(
      true,
    );
    d.rules.push({
      ...structuredClone(d.rules[0]),
      id: "EXAMPLE-2",
      answer: false,
    });
    expect(validatePolicy(d).valid).toBe(true);
    d.questions[0].prompt = "New wording with no recognized legacy phrase";
    const catalog = compilePolicy(d);
    expect(
      evaluateCondition({
        condition: { category: "Example category", severity: 1 },
        catalog,
      }),
    ).toMatchObject({
      kind: "needs_answer",
      question: { key: "example_question" },
    });
    expect(
      evaluateCondition({
        condition: { category: "Example category", severity: 1 },
        answers: { example_question: false },
        catalog,
      }),
    ).toMatchObject({ kind: "outcome", rule: { ruleId: "EXAMPLE-2" } });
  });
  it("preserves Pacific schedule behavior at DST skips and repeated hours", () => {
    const d = examplePolicy();
    d.rules[0].schedule = {
      always: false,
      start: 540,
      end: 1020,
      days: [0, 1, 2, 3, 4, 5, 6],
    };
    d.rules.push({
      ...d.rules[0],
      id: "EXAMPLE-2",
      schedule: {
        always: false,
        start: 1021,
        end: 539,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    const catalog = compilePolicy(d);
    for (const reportedAt of [
      "2026-03-08T09:59:00Z",
      "2026-03-08T10:00:00Z",
      "2026-11-01T08:30:00Z",
      "2026-11-01T09:30:00Z",
    ]) {
      expect(
        evaluateCondition({
          condition: { category: "Example category", severity: 1 },
          reportedAt,
          catalog,
        }),
      ).toMatchObject({ kind: "outcome", rule: { ruleId: "EXAMPLE-2" } });
    }
    for (const reportedAt of ["2026-03-08T16:00:00Z", "2026-11-01T17:00:00Z"]) {
      expect(
        evaluateCondition({
          condition: { category: "Example category", severity: 1 },
          reportedAt,
          catalog,
        }),
      ).toMatchObject({ kind: "outcome", rule: { ruleId: "EXAMPLE-1" } });
    }
  });
  it("rejects dangling references, malformed schedules, missing deadlines and unsupported actions", () => {
    const d = examplePolicy();
    Object.assign(d.rules[0], {
      questionId: "missing",
      responseHours: null,
      actionType: "arbitrary",
    });
    d.rules[0].schedule = { always: false, start: 0, end: 1440, days: [] };
    expect(validatePolicy(d).issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "unknownQuestion",
        "invalidSchedule",
        "invalidDeadline",
        "invalidAction",
      ]),
    );
  });
  it("requires every translation for a release but allows incomplete drafts", () => {
    const d = examplePolicy();
    expect(validatePolicy(d).valid).toBe(true);
    expect(validatePolicy(d, { translations: true }).valid).toBe(false);
    d.translations = Object.fromEntries(
      ["es", "fil", "vi", "zh-Hant"].map((locale) => [locale, policyTexts(d)]),
    );
    expect(validatePolicy(d, { translations: true }).valid).toBe(true);
  });
  it("compiles a stable question ID safely even when it resembles an inherited property", () => {
    const d = examplePolicy();
    d.questions = [{ id: "constructor", prompt: "Synthetic question?" }];
    d.rules[0].questionId = "constructor";
    expect(
      evaluateCondition({
        condition: { category: "Example category", severity: 1 },
        catalog: compilePolicy(d),
      }).kind,
    ).toBe("needs_answer");
  });
  it("enforces request shape and bounded enumeration", () => {
    expect(isPolicyDocument(null)).toBe(false);
    expect(isPolicyDocument({})).toBe(false);
    const d = examplePolicy();
    d.rules[0].schedule.days = Array(8).fill(0);
    expect(isPolicyDocument(d)).toBe(false);
  });
  it("does not mistake inherited object properties for rule witnesses", () => {
    const d = examplePolicy();
    d.rules.push({ ...d.rules[0], id: "constructor", order: 2 });
    expect(validatePolicy(d).issues).toContainEqual(
      expect.objectContaining({ code: "unreachable", ruleId: "constructor" }),
    );
    d.rules = [{ ...d.rules[0], id: "constructor" }];
    expect(Object.hasOwn(validatePolicy(d).witnesses, "constructor")).toBe(
      true,
    );
  });
});

describe("policy migration", () => {
  it("keeps the bundled recognition source aligned with the reviewed CSV", () => {
    expect(POLICY_CATEGORY_SOURCE).toEqual(
      readPolicyCsv(
        readFileSync(
          new URL("./sources/GNP-categories-v2.csv", import.meta.url),
          "utf8",
        ),
      ).slice(1),
    );
  });
  it("seeds the current running catalog without altering the source conflicts", () => {
    const d = initialPolicyDocument();
    expect(d.categories.length).toBeGreaterThan(0);
    expect(d.rules.map((r) => r.id)).toEqual(
      activeCatalog().rules.map((r) => r.ruleId),
    );
    expect(isPolicyDocument(d)).toBe(true);
    for (const rule of d.rules)
      expect(rule.order).toBe(
        activeCatalog().rules.find((r) => r.ruleId === rule.id)
          ?.evaluationOrder,
      );
  });
  it("roundtrips CSV with arbitrary question wording and explicit boolean semantics", () => {
    const d = examplePolicy();
    d.questions = [
      { id: "custom_question", prompt: 'A new question, with "quotes"?' },
    ];
    d.rules[0].questionId = "custom_question";
    const files = exportPolicyCsv(d),
      next = importPolicyCsv(files.categoriesCsv, files.rulesCsv);
    expect(next.rules[0].questionId).toBe("custom_question");
    expect(next.questions[0].prompt).toBe(d.questions[0].prompt);
    expect(next.rules[0].responseHours).toBe(4);
    expect(next.categories[0].severityGuidance).toEqual(
      d.categories[0].severityGuidance,
    );
  });
  it("rejects malformed CSV and prevents spreadsheet formula execution in exports", () => {
    expect(() => readPolicyCsv('"unterminated')).toThrow();
    expect(() => readPolicyCsv("a,b\nx")).toThrow();
    expect(
      readPolicyCsv(writePolicyCsv([["=1+1", "Example\ntext", 'a"b']])),
    ).toEqual([["'=1+1", "Example\ntext", 'a"b']]);
  });
});
