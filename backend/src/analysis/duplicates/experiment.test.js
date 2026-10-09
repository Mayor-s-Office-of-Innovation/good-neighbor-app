import { describe, expect, it } from "vitest";
import {
  baselinePrediction,
  comparisonPrompt,
  evaluate,
  retrieveCandidates,
  validateDataset,
  validatePrediction,
} from "./experiment.js";

/**
 * @param {Partial<import("./experiment.js").Observation>} [overrides]
 * @returns {import("./experiment.js").Observation}
 */
function observation(overrides = {}) {
  return {
    id: "prior",
    siteId: "site-a",
    category: "Litter",
    description: "Red bags by the blue gate",
    observedAt: "2026-10-02T10:00:00Z",
    availableAt: "2026-10-02T10:01:00Z",
    ...overrides,
  };
}

const source = observation({
  id: "source",
  sourceId: "artifact-condition",
  observedAt: "2026-10-09T10:00:00Z",
  availableAt: "2026-10-09T10:01:00Z",
});

describe("duplicate candidate replay", () => {
  it("retains all seventy candidates rather than silently truncating retrieval", () => {
    const candidates = Array.from({ length: 70 }, (_, index) =>
      observation({ id: `candidate-${index}` }),
    );
    expect(retrieveCandidates(source, candidates)).toHaveLength(70);
    expect(
      JSON.parse(comparisonPrompt(source, candidates).user).candidates,
    ).toHaveLength(70);
  });
  it("includes the seven-day boundary without category or GPS filters", () => {
    const prior = observation({ category: "Other category" });
    expect(retrieveCandidates(source, [prior])).toEqual([prior]);
    expect(
      retrieveCandidates(source, [
        observation({ observedAt: "2026-10-02T09:59:59Z" }),
      ]),
    ).toEqual([]);
  });

  it.each([
    { siteId: "other-site" },
    { id: "source" },
    { sourceId: "artifact-condition" },
    { resolvedAt: "2026-10-09T10:00:00Z" },
    { supersededAt: "2026-10-09T10:01:00Z" },
    { availableAt: "2026-10-09T10:02:00Z" },
    { observedAt: "2026-10-09T10:00:01Z" },
  ])("excludes ineligible observations: %j", (overrides) => {
    expect(retrieveCandidates(source, [observation(overrides)])).toEqual([]);
  });

  it("does not use future resolution or supersession to change historical eligibility", () => {
    const prior = observation({
      resolvedAt: "2026-10-10T10:00:00Z",
      supersededAt: "2026-10-10T11:00:00Z",
    });
    expect(retrieveCandidates(source, [prior])).toEqual([prior]);
  });

  it("keeps multiple conditions from the same artifact when their source IDs differ", () => {
    const prior = observation({ sourceId: "artifact-other-condition" });
    expect(retrieveCandidates(source, [prior])).toEqual([prior]);
  });
});

describe("baseline and model boundary", () => {
  it("produces an advisory flag and specific target, never a calibrated probability", () => {
    expect(baselinePrediction(source, [observation()])).toMatchObject({
      status: "evaluated",
      possibleDuplicate: true,
      duplicateOf: "prior",
      matchStrength: "tentative",
    });
  });

  it("does not equate missing description with a negative evaluation", () => {
    expect(
      baselinePrediction({ ...source, description: "" }, [observation()]),
    ).toMatchObject({
      status: "insufficient_evidence",
      possibleDuplicate: null,
    });
    expect(baselinePrediction(source, [])).toMatchObject({
      status: "evaluated",
      possibleDuplicate: false,
    });
  });

  it("does not reward matching fallback site coordinates", () => {
    const location = {
      source: /** @type {const} */ ("site"),
      latitude: 37.7,
      longitude: -122.4,
    };
    expect(
      baselinePrediction({ ...source, location }, [observation({ location })])
        .score,
    ).toBe(baselinePrediction(source, [observation()]).score);
  });

  it("reports ambiguity and uses a stable tie break independent of query order", () => {
    const candidates = [
      observation({ id: "second" }),
      observation({ id: "first" }),
    ];
    const prediction = baselinePrediction(source, candidates);
    expect(prediction.duplicateOf).toBe("first");
    expect(prediction.reasons).toContain(
      "Multiple similarly ranked candidates",
    );
    expect(baselinePrediction(source, candidates.reverse())).toEqual(
      prediction,
    );
  });

  it("never exports labels, lifecycle futures, or extra fields into model evidence", () => {
    const prompt = comparisonPrompt(
      { ...source, resolvedAt: "2026-10-15T10:00:00Z" },
      [observation({ supersededAt: "2026-10-16T10:00:00Z" })],
    );
    expect(prompt.user).not.toContain("2026-10-15");
    expect(prompt.user).not.toContain("supersededAt");
    expect(prompt.system).toContain("untrusted data");
    expect(JSON.parse(prompt.user).candidates).toHaveLength(1);
  });

  it("rejects hallucinated, resolved, or cross-site target IDs", () => {
    const prediction = baselinePrediction(source, [observation()]);
    expect(() =>
      validatePrediction({ ...prediction, duplicateOf: "not-eligible" }, [
        observation(),
      ]),
    ).toThrow("eligible");
    expect(() => validatePrediction(prediction, [])).toThrow("eligible");
  });

  it("rejects failures disguised as negative results and malformed scores", () => {
    const negative = baselinePrediction(source, []);
    expect(() =>
      validatePrediction({ ...negative, status: "failed" }, []),
    ).toThrow("Unevaluated");
    expect(() => validatePrediction({ ...negative, score: NaN }, [])).toThrow(
      "Malformed",
    );
  });
});

describe("evaluation metrics and input validation", () => {
  /** @returns {import("./experiment.js").Dataset} */
  function dataset() {
    return {
      name: "test",
      synthetic: true,
      observations: [
        observation({ description: "Discarded sofa" }),
        observation({ id: "wrong" }),
        source,
        observation({ id: "new-incident", siteId: "site-b" }),
        observation({ id: "unknown", siteId: "site-c" }),
      ],
      cases: [
        {
          sourceId: "source",
          label: "duplicate",
          duplicateIds: ["prior"],
          split: "development",
        },
        {
          sourceId: "new-incident",
          label: "distinct",
          duplicateIds: [],
          split: "development",
        },
        {
          sourceId: "unknown",
          label: "indeterminate",
          duplicateIds: [],
          split: "test",
        },
      ],
    };
  }

  it("separates candidate recall, flag recall, and correct target recall", () => {
    const report = evaluate(validateDataset(dataset()));
    expect(report.metrics).toMatchObject({
      candidateRecall: 1,
      flagRecall: 1,
      correctTargetRecall: 0,
      suggestionPrecision: 0,
      falseFlagRate: 0,
      indeterminateLabelRate: 1 / 3,
    });
    expect(report.totals.wrongTargets).toBe(1);
  });

  it("includes missed retrieval in the recall denominator", () => {
    const input = dataset();
    input.observations[0].availableAt = "2026-10-10T10:00:00Z";
    expect(evaluate(input).metrics.candidateRecall).toBe(0);
  });

  it("requires an explicit result for every selected case", () => {
    expect(() => evaluate(dataset(), { predictions: new Map() })).toThrow(
      "Missing prediction",
    );
  });

  it("keeps failed cases in recall denominators", () => {
    const predictions = new Map([
      [
        "source",
        {
          status: /** @type {const} */ ("failed"),
          possibleDuplicate: null,
          duplicateOf: null,
          matchStrength: null,
          score: null,
          reasons: ["Timeout"],
          matcherVersion: "test-model",
        },
      ],
      ["new-incident", baselinePrediction(source, [])],
    ]);
    expect(
      evaluate(dataset(), { predictions, split: "development" }).metrics,
    ).toMatchObject({ correctTargetRecall: 0, failureRate: 0.5 });
  });

  it("does not count indeterminate labels as negatives or invent zero rates", () => {
    const report = evaluate(dataset(), { split: "test" });
    expect(report.totals.cases).toBe(1);
    expect(report.metrics.falseFlagRate).toBeNull();
    expect(report.metrics.correctTargetRecall).toBeNull();
  });

  it("rejects malformed datasets before computing rates", () => {
    const input = dataset();
    input.observations[0].observedAt = "yesterday";
    expect(() => validateDataset(input)).toThrow("Invalid observation");
    expect(() =>
      validateDataset({
        ...dataset(),
        cases: [...dataset().cases, dataset().cases[0]],
      }),
    ).toThrow("Invalid evaluation case");
    expect(() =>
      validateDataset({
        ...dataset(),
        observations: [...dataset().observations, source],
      }),
    ).toThrow("duplicate observation");
  });

  it("rejects impossible ground truth and directly linked cases across splits", () => {
    const input = dataset();
    input.observations[0].resolvedAt = "2026-10-03T10:00:00Z";
    expect(() => validateDataset(input)).toThrow("resolved before");
    const leaked = dataset();
    leaked.cases.push({
      sourceId: "prior",
      label: "distinct",
      duplicateIds: [],
      split: "test",
    });
    expect(() => validateDataset(leaked)).toThrow("cross evaluation splits");
  });
});
