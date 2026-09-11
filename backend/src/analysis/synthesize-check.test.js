import { describe, expect, it } from "vitest";
import { adaptAssessment } from "./adapt-scorecard.js";
import { synthesizeCheck } from "./synthesize-check.js";
import { excellentResponse } from "./fixtures/excellent.js";
import { singleLowConcernResponse } from "./fixtures/single-low-concern.js";
import { multiHighConcernResponse } from "./fixtures/multi-high-concern.js";

/**
 * @param {string} artifactId
 * @param {import("./contract.js").AnalysisResponse} response
 * @param {string} [placeName]
 * @returns {import("./synthesize-check.js").AnalyzedArtifact}
 */
const analyzed = (artifactId, response, placeName) => ({
  artifactId,
  placeName,
  adapted: adaptAssessment(response),
});

describe("synthesizeCheck", () => {
  it("takes the worst grade across the run's artifacts", () => {
    const scorecard = synthesizeCheck([
      analyzed("art_01", excellentResponse, "north"),
      analyzed("art_02", singleLowConcernResponse, "east"),
      analyzed("art_03", multiHighConcernResponse, "south"),
    ]);
    expect(scorecard.grade).toBe("Very Poor");
    expect(scorecard.rubricVersion).toBe("1.0.0");
    // The overall summary is the general_conditions.description of the place that
    // set the worst grade (multiHighConcernResponse / "south").
    expect(scorecard.summary).toBe(
      multiHighConcernResponse.assessment.general_conditions.description,
    );
  });

  it("uses the description from the first place to reach the worst grade (ties)", () => {
    // Two Very Poor places: the first one wins, so its description is the summary.
    const scorecard = synthesizeCheck([
      analyzed("art_01", excellentResponse, "north"),
      analyzed("art_02", multiHighConcernResponse, "east"),
      analyzed("art_03", multiHighConcernResponse, "south"),
    ]);
    expect(scorecard.grade).toBe("Very Poor");
    expect(scorecard.summary).toBe(
      multiHighConcernResponse.assessment.general_conditions.description,
    );
  });

  it("keeps an all-clean run at Excellent with no categories", () => {
    const scorecard = synthesizeCheck([analyzed("art_01", excellentResponse)]);
    expect(scorecard.grade).toBe("Excellent");
    expect(scorecard.categories).toEqual([]);
    expect(scorecard.issueCount).toBe(0);
    expect(scorecard.maxSeverity).toBe(0);
  });

  it("rolls up per-category max rating and attributes source artifacts", () => {
    // Two artifacts both flag Litter — different severities in different places.
    const scorecard = synthesizeCheck([
      analyzed("art_02", singleLowConcernResponse, "east"),
      analyzed("art_03", multiHighConcernResponse, "south"),
    ]);

    const litter = scorecard.categories.find((c) => c.category === "Litter");
    expect(litter).toEqual({
      category: "Litter",
      maxRating: 2,
      sourceArtifactIds: ["art_02", "art_03"],
    });

    const needles = scorecard.categories.find((c) => c.category === "Needles");
    expect(needles).toEqual({
      category: "Needles",
      maxRating: 5,
      sourceArtifactIds: ["art_03"],
    });

    expect(scorecard.maxSeverity).toBe(5);
    expect(scorecard.issueCount).toBe(3);
  });

  it("returns a null grade for an empty run", () => {
    const scorecard = synthesizeCheck([]);
    expect(scorecard.grade).toBeNull();
    expect(scorecard.summary).toBeNull();
    expect(scorecard.rubricVersion).toBeNull();
    expect(scorecard.categories).toEqual([]);
  });
});
