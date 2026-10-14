import { describe, it, expect } from "vitest";
import {
  eligibleImages,
  matchImages,
  createComparisonClient,
  markUnassessedCandidates,
  assessConfidence,
} from "./image-matcher.js";
/**
 * @param {string} id
 * @param {Partial<import("./image-matcher.js").ImageObservation>} extra
 * @returns {import("./image-matcher.js").ImageObservation}
 */
const observation = (id, extra = {}) => ({
  id,
  siteId: "site",
  observedAt: "2026-10-14T12:00:00Z",
  availableAt: "2026-10-14T12:01:00Z",
  revision: "1",
  image: { content_type: "image/jpeg", base64: "image" },
  ...extra,
});
/**
 * @param {import("./image-matcher.js").ComparisonRequest} request
 * @param {string} verdict
 * @param {string} strength
 * @returns {import("./image-matcher.js").ComparisonResponse}
 */
const response = (request, verdict = "same_issue", strength = "strong") => ({
  comparison_version: "v1",
  model: { model_id: "test" },
  comparisons: request.candidates.map((c) => ({
    candidate_id: c.id,
    verdict,
    evidence_strength: strength,
    reason: "Matching objects",
    source_region: "pile",
    candidate_region: "pile",
    evidence: {
      visual_identity: "clear",
      issue_mapping: request.mode === "context" ? "clear" : "none",
      matching_features: ["Distinctive object"],
      visible_differences: ["Different object"],
      contradictions: [],
      description_conflict: "none",
      continuity_concern: "none",
    },
    condition_matches:
      request.mode === "context" && verdict === "same_issue"
        ? [
            {
              evidence: {
                visual_identity: "clear",
                issue_mapping: "clear",
                matching_features: ["Distinctive object"],
                visible_differences: [],
                contradictions: [],
                description_conflict: "none",
                continuity_concern: "none",
              },
              source_condition_id:
                request.source.context?.conditions[0]?.id ?? "missing-source",
              candidate_condition_id:
                c.context?.conditions[0]?.id ?? "missing-candidate",
            },
          ]
        : [],
  })),
});
describe("image-first backend matcher", () => {
  it("derives evidence bands for positives and negatives, without rewarding wording conflicts", () => {
    const evidence = {
      visual_identity: "clear",
      issue_mapping: "clear",
      matching_features: ["Matching cabinet geometry"],
      visible_differences: [],
      contradictions: [],
      description_conflict: "resolved",
      continuity_concern: "none",
    };
    expect(assessConfidence("same_issue", evidence).confidence).toBe("high");
    expect(
      assessConfidence("same_issue", {
        ...evidence,
        continuity_concern: "unknown",
      }).confidence,
    ).toBe("medium");
    expect(
      assessConfidence("same_issue", {
        ...evidence,
        issue_mapping: "ambiguous",
      }).confidence,
    ).toBe("low");
    expect(assessConfidence("same_issue", evidence, true).confidence).toBe(
      "low",
    );
    expect(assessConfidence("different_issue", evidence).confidence).toBe(
      "medium",
    );
    expect(
      assessConfidence("different_issue", {
        ...evidence,
        visible_differences: ["Different object geometry"],
      }).confidence,
    ).toBe("high");
    expect(
      assessConfidence("different_issue", {
        ...evidence,
        description_conflict: "unresolved",
      }).confidence,
    ).toBe("low");
  });
  it("keeps mapped medium matches as review suggestions without setting duplicate flags", async () => {
    const source = observation("s", {
      observedAt: undefined,
      conditions: [{ id: "s1", description: "box" }],
    });
    const candidate = observation("c", {
      conditions: [{ id: "c1", description: "cabinet" }],
    });
    const result = await matchImages({
      source,
      candidates: [candidate],
      compare: async (request) => response(request),
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].confidence).toBe("medium");
    expect(result.conditionResults[0].possibleDuplicate).toBeNull();
    expect(result.possibleDuplicate).toBeNull();
  });
  it("carries visual correspondence into context and keeps contradictory negatives uncertain", async () => {
    const source = observation("s", {
      conditions: [{ id: "s1", description: "box" }],
    });
    const candidate = observation("c", {
      conditions: [{ id: "c1", description: "cabinet" }],
    });
    const result = await matchImages({
      source,
      candidates: [candidate],
      compare: async (request) => {
        if (request.mode === "context") {
          expect(request.candidates[0].context?.visualAssessment?.verdict).toBe(
            "same_issue",
          );
          return response(request, "different_issue");
        }
        return response(request);
      },
    });
    expect(result.possibleDuplicate).toBeNull();
    expect(result.conditionResults[0].possibleDuplicate).toBeNull();
    expect(result.comparisons[0].verdict).toBe("uncertain");
    expect(result.suggestions).toEqual([]);
  });
  it("never infers single-issue identity from a strong image match without explicit mapping", async () => {
    const source = observation("s", {
      conditions: [{ id: "s1", description: "litter" }],
    });
    const candidate = observation("c", {
      conditions: [{ id: "c1", description: "blocked sidewalk" }],
    });
    const result = await matchImages({
      source,
      candidates: [candidate],
      compare: async (request) => {
        const value = response(request);
        value.comparisons[0].condition_matches = [];
        return value;
      },
    });
    expect(result.calls).toBe(2);
    expect(result.suggestions).toEqual([]);
    expect(result.possibleDuplicate).toBeNull();
    expect(result.conditionResults[0].possibleDuplicate).toBeNull();
  });
  it("does not flag media with no analyzer issues as a duplicate", async () => {
    const result = await matchImages({
      source: observation("s"),
      candidates: [observation("c")],
      compare: async (request) => response(request),
    });
    expect(result.possibleDuplicate).toBeNull();
    expect(result.suggestions).toEqual([]);
  });
  it("exhaustive evaluation continues after all source conditions have matches", async () => {
    const source = observation("s", {
      conditions: [{ id: "sc", description: "pile" }],
    });
    const candidates = Array.from({ length: 9 }, (_, i) =>
      observation(`c${i}`, { conditions: [{ id: "cc", description: "pile" }] }),
    );
    /** @type {import("./image-matcher.js").Compare} */
    const compare = async (request) => response(request);
    const normal = await matchImages({ source, candidates, compare });
    const exhaustive = await matchImages({
      source,
      candidates,
      compare,
      exhaustive: true,
    });
    expect(normal.assessedCandidateCount).toBe(4);
    expect(exhaustive.assessedCandidateCount).toBe(9);
    expect(exhaustive.unassessedCandidateIds).toEqual([]);
  });
  it("enforces five-day inclusive boundary, availability, site and resolution", () => {
    const source = observation("source");
    const candidates = [
      observation("boundary", { observedAt: "2026-10-09T12:00:00Z" }),
      observation("old", { observedAt: "2026-10-09T11:59:59Z" }),
      observation("late", { availableAt: "2026-10-14T12:02:00Z" }),
      observation("other", { siteId: "other" }),
      observation("resolved", { resolvedAt: "2026-10-14T11:00:00Z" }),
    ];
    expect(eligibleImages(source, candidates).map((c) => c.id)).toEqual([
      "boundary",
    ]);
    expect(() =>
      eligibleImages(observation("unknown", { observedAt: undefined }), []),
    ).toThrow();
  });
  it("does not send context in the first pass; falls back only for uncertainty", async () => {
    /** @type {import("./image-matcher.js").ComparisonRequest[]} */ const calls =
      [];
    const source = observation("s", {
      conditions: [{ id: "sc", description: "source secret" }],
    });
    const candidate = observation("c", {
      conditions: [{ id: "cc", description: "target secret" }],
    });
    const result = await matchImages({
      source,
      candidates: [candidate],
      compare: async (request) => {
        calls.push(request);
        return response(
          request,
          request.mode === "image" ? "uncertain" : "same_issue",
          request.mode === "image" ? "tentative" : "strong",
        );
      },
    });
    expect(calls.map((c) => c.mode)).toEqual(["image", "context"]);
    expect(JSON.stringify(calls[0])).not.toContain("secret");
    expect(result.conditionSuggestions[0].candidate_condition_id).toBe("cc");
  });
  it("assesses every candidate even with unrelated perceptual hashes", async () => {
    const source = observation("s", {
      conditions: [{ id: "sc", description: "issue" }],
    });
    const candidates = Array.from({ length: 9 }, (_, i) =>
      observation(`c${i}`, { perceptualHash: "1".repeat(64) }),
    );
    let count = 0;
    const result = await matchImages({
      source,
      candidates,
      compare: async (request) => {
        count += request.candidates.length;
        return response(request, "different_issue");
      },
    });
    expect(count).toBe(9);
    expect(result.calls).toBe(3);
    expect(result.possibleDuplicate).toBe(false);
  });
  it("never turns failure or missing candidates into a negative", async () => {
    const source = observation("s");
    const result = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async () => {
        throw new Error("down");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.possibleDuplicate).toBeNull();
    const malformed = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async () => ({
        comparison_version: "v1",
        model: { model_id: "m" },
        comparisons: [],
      }),
    });
    expect(malformed.status).toBe("failed");
  });
  it("requires context to bind multi-condition images and rejects invented IDs", async () => {
    const source = observation("s", {
      conditions: [
        { id: "s1", description: "one" },
        { id: "s2", description: "two" },
      ],
    });
    const candidate = observation("c", {
      conditions: [{ id: "c1", description: "one" }],
    });
    /** @type {string[]} */ const calls = [];
    const result = await matchImages({
      source,
      candidates: [candidate],
      compare: async (request) => {
        calls.push(request.mode);
        const value = response(request);
        if (request.mode === "context")
          value.comparisons[0].condition_matches = [
            {
              source_condition_id: "invented",
              candidate_condition_id: "c1",
              evidence: value.comparisons[0].evidence,
            },
          ];
        return value;
      },
    });
    expect(calls).toEqual(["image", "context"]);
    expect(result.status).toBe("failed");
  });
  it("rejects non-TLS remote comparison endpoints", () => {
    expect(() =>
      createComparisonClient({
        baseUrl: "http://remote.example",
        apiKey: "secret",
      }),
    ).toThrow();
  });
});

it("stops model escalation once all identified conditions have strong targets", async () => {
  const source = observation("s", {
    conditions: [{ id: "s1", description: "one" }],
  });
  const candidates = Array.from({ length: 9 }, (_, i) =>
    observation(`c${i}`, { conditions: [{ id: `t${i}`, description: "one" }] }),
  );
  const result = await matchImages({
    source,
    candidates,
    compare: async (request) => response(request),
  });
  expect(result.calls).toBe(2);
  expect(result.assessedCandidateCount).toBe(4);
  expect(result.unassessedCandidateIds).toHaveLength(5);
  expect(result.possibleDuplicate).toBe(true);
});

it("a shortlist leaves unassessed candidates unknown rather than negative", async () => {
  const source = observation("source", {
    conditions: [{ id: "s1", description: "issue" }],
  });
  const candidates = [observation("a"), observation("b")];
  const partial = await matchImages({
    source,
    candidates: candidates.slice(0, 1),
    compare: async (request) => response(request, "different_issue"),
  });
  const result = markUnassessedCandidates(partial, candidates);
  expect(result.status).toBe("insufficient_evidence");
  expect(result.possibleDuplicate).toBeNull();
  expect(result.unassessedCandidateIds).toEqual(["b"]);
  expect(result.conditionResults[0].possibleDuplicate).toBeNull();
});
