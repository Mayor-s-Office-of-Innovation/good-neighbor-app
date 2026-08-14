import { describe, expect, it } from "vitest";
import { adaptAssessment } from "./adapt-scorecard.js";
import { synthesizeCheck } from "./synthesize-check.js";
import { excellentResponse } from "./fixtures/excellent.js";
import { singleLowConcernResponse } from "./fixtures/single-low-concern.js";
import { multiHighConcernResponse } from "./fixtures/multi-high-concern.js";

/**
 * @param {string} artifactId
 * @param {import("./contract.js").AnalysisResponse} response
 * @param {string} [side]
 * @returns {import("./synthesize-check.js").AnalyzedArtifact}
 */
const analyzed = (artifactId, response, side) => ({
  artifactId,
  side,
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
  });

  it("keeps an all-clean run at Excellent with no categories", () => {
    const scorecard = synthesizeCheck([analyzed("art_01", excellentResponse)]);
    expect(scorecard.grade).toBe("Excellent");
    expect(scorecard.categories).toEqual([]);
    expect(scorecard.issueCount).toBe(0);
    expect(scorecard.maxSeverity).toBe(0);
  });

  it("rolls up per-category max rating and attributes source artifacts", () => {
    // Two artifacts both flag Litter — different severities on different sides.
    const scorecard = synthesizeCheck([
      analyzed("art_02", singleLowConcernResponse, "east"),
      analyzed("art_03", multiHighConcernResponse, "south"),
    ]);

    const litter = scorecard.categories.find((c) => c.category === "Litter");
    expect(litter).toEqual({
      category: "Litter",
      weighting: "Low",
      maxRating: 2,
      sourceArtifactIds: ["art_02", "art_03"],
    });

    const needles = scorecard.categories.find((c) => c.category === "Needles");
    expect(needles).toEqual({
      category: "Needles",
      weighting: "High",
      maxRating: 5,
      sourceArtifactIds: ["art_03"],
    });

    expect(scorecard.maxSeverity).toBe(5);
    expect(scorecard.issueCount).toBe(3);
  });

  it("returns a null grade for an empty run", () => {
    const scorecard = synthesizeCheck([]);
    expect(scorecard.grade).toBeNull();
    expect(scorecard.rubricVersion).toBeNull();
    expect(scorecard.categories).toEqual([]);
  });
});
