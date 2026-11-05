import { describe, expect, it } from "vitest";
import { assertNoJudgementFields } from "./contract.js";

describe("assertNoJudgementFields", () => {
  it("rejects compliance and score columns", () => {
    expect(() => assertNoJudgementFields(["siteId", "requiredChecks"])).toThrow(
      "requiredChecks",
    );
    expect(() => assertNoJudgementFields(["compliancePct"])).toThrow();
    expect(() => assertNoJudgementFields(["expected_checks"])).toThrow();
  });

  it("rejects plurals, other forms and capitalised short forms", () => {
    for (const name of [
      "siteScores",
      "percentage",
      "ranking",
      "passRate",
      "failedChecks",
      "requirementsMet",
      "PCTOnTime",
    ])
      expect(() => assertNoJudgementFields([name])).toThrow(name);
  });

  it("allows names that only contain one of those words", () => {
    expect(() =>
      assertNoJudgementFields(["unexpectedCount", "bypassedAt", "frankId"]),
    ).not.toThrow();
  });
});
