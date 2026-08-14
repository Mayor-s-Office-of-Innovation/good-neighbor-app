import { describe, expect, it } from "vitest";
import { adaptAssessment } from "./adapt-scorecard.js";
import { excellentResponse } from "./fixtures/excellent.js";
import { singleLowConcernResponse } from "./fixtures/single-low-concern.js";
import { multiHighConcernResponse } from "./fixtures/multi-high-concern.js";
import { realPoorSampleResponse } from "./fixtures/real-poor-sample.js";

describe("adaptAssessment", () => {
  it("adopts the service grade and carries provenance", () => {
    const adapted = adaptAssessment(excellentResponse);
    expect(adapted.grade).toBe("Excellent");
    expect(adapted.gradeDescription).toMatch(/clean/i);
    expect(adapted.analysisId).toBe("ana_20260814_clean01");
    expect(adapted.rubricVersion).toBe("1.0.0");
    expect(adapted.model).toEqual(excellentResponse.model);
  });

  it("returns no concerns for a clean assessment", () => {
    const adapted = adaptAssessment(excellentResponse);
    expect(adapted.concerns).toEqual([]);
    expect(adapted.issueCount).toBe(0);
    expect(adapted.maxSeverity).toBe(0);
  });

  it("projects a concern's fields to our naming", () => {
    const adapted = adaptAssessment(singleLowConcernResponse);
    expect(adapted.concerns).toHaveLength(1);
    const [concern] = adapted.concerns;
    expect(concern).toEqual({
      category: "Litter",
      rating: 2,
      ratingLabel: "Minor: Increasing quantity, size, or spatial impact",
      explanation: "Several wrappers and a plastic bag scattered along the curb.",
      evidenceIndices: [0],
    });
    expect(adapted.issueCount).toBe(1);
    expect(adapted.maxSeverity).toBe(2);
  });

  it("drops confidence/definition and does not compute a total_score", () => {
    const adapted = adaptAssessment(multiHighConcernResponse);
    expect(adapted).not.toHaveProperty("totalScore");
    expect(adapted.concerns[0]).not.toHaveProperty("confidence");
    expect(adapted.concerns[0]).not.toHaveProperty("definition");
    expect(adapted.concerns[0]).not.toHaveProperty("weighting");
    expect(adapted.grade).toBe("Very Poor");
  });

  it("rolls up issueCount / maxSeverity across concerns", () => {
    const adapted = adaptAssessment(multiHighConcernResponse);
    expect(adapted.concerns.map((c) => [c.category, c.rating])).toEqual([
      ["Needles", 5],
      ["Temporary shelters", 3],
      ["Litter", 2],
    ]);
    expect(adapted.issueCount).toBe(3);
    expect(adapted.maxSeverity).toBe(5);
  });

  it("omits ratingLabel when the service does not provide one", () => {
    const adapted = adaptAssessment(multiHighConcernResponse);
    const litter = adapted.concerns.find((c) => c.category === "Litter");
    expect(litter).not.toHaveProperty("ratingLabel");
  });

  it("adapts a real captured service response (golden conformance)", () => {
    const adapted = adaptAssessment(realPoorSampleResponse);
    expect(adapted.grade).toBe("Poor");
    expect(adapted.analysisId).toBe("ana_20260814_54234580279c");
    expect(adapted.concerns.map((c) => [c.category, c.rating])).toEqual([
      ["Litter", 2],
      ["Large waste", 3],
      ["Feces and urine", 3],
      ["Temporary shelters", 4],
      ["Graffiti", 1],
      ["Blocking access", 3],
      ["Dangerous animals", 2],
    ]);
    expect(adapted.issueCount).toBe(7);
    expect(adapted.maxSeverity).toBe(4);
    // The grade description is carried through verbatim — we do not sanitize the
    // service's output, so the upstream `\nOR\n` template artifact rides along.
    expect(adapted.gradeDescription).toContain("\nOR\n");
  });
});
