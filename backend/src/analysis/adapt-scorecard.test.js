import { describe, expect, it } from "vitest";
import { adaptAssessment } from "./adapt-scorecard.js";
import { excellentResponse } from "./fixtures/excellent.js";
import { singleLowConcernResponse } from "./fixtures/single-low-concern.js";
import { multiHighConcernResponse } from "./fixtures/multi-high-concern.js";

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
    expect(adapted.unknownCategories).toEqual([]);
  });

  it("maps a concern's fields and joins weighting from rubric-meta", () => {
    const adapted = adaptAssessment(singleLowConcernResponse);
    expect(adapted.concerns).toHaveLength(1);
    const [concern] = adapted.concerns;
    expect(concern).toEqual({
      category: "Litter",
      weighting: "Low",
      rating: 2,
      ratingLabel: "Minor: Increasing quantity, size, or spatial impact",
      explanation: "Several wrappers and a plastic bag scattered along the curb.",
      evidenceIndices: [0],
    });
    expect(adapted.issueCount).toBe(1);
    expect(adapted.maxSeverity).toBe(2);
  });

  it("does not compute a total_score (grade comes from the service)", () => {
    const adapted = adaptAssessment(multiHighConcernResponse);
    expect(adapted).not.toHaveProperty("totalScore");
    expect(adapted.grade).toBe("Very Poor");
  });

  it("weights every concern and rolls up issueCount / maxSeverity", () => {
    const adapted = adaptAssessment(multiHighConcernResponse);
    expect(adapted.concerns.map((c) => [c.category, c.weighting, c.rating])).toEqual([
      ["Needles", "High", 5],
      ["Temporary shelters", "High", 3],
      ["Litter", "Low", 2],
    ]);
    expect(adapted.issueCount).toBe(3);
    expect(adapted.maxSeverity).toBe(5);
    expect(adapted.unknownCategories).toEqual([]);
  });

  it("flags an unknown category with null weighting instead of guessing", () => {
    const drifted = {
      ...multiHighConcernResponse,
      assessment: {
        ...multiHighConcernResponse.assessment,
        identified_conditions_of_concern: [
          {
            category: "Rogue drones",
            definition: "Not in the pinned rubric.",
            severity: 4,
            description: "A category the rubric-meta map does not know.",
            evidence_indices: [0],
          },
        ],
      },
    };
    const adapted = adaptAssessment(drifted);
    expect(adapted.concerns[0].weighting).toBeNull();
    expect(adapted.unknownCategories).toEqual(["Rogue drones"]);
  });
});
