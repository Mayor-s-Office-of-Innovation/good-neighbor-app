import { describe, it, expect } from "vitest";
import {
  eligibleImages,
  matchImages as runMatcher,
  createComparisonClient,
  markUnassessedCandidates,
  assessConfidence,
} from "./image-matcher.js";
/** @param {Parameters<typeof runMatcher>[0]} input */
const matchImages = (input) => runMatcher({ ...input, strategy: "legacy" });
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
  conditions: (
    extra.conditions ?? [{ id: "default", description: "issue" }]
  ).map((c) => ({ category: "test-category", ...c })),
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
      matching_features: ["Blue crate with broken left handle"],
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
                matching_features: ["Blue crate with broken left handle"],
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
  it("publishes qualified issue positives before completion and retains them when unrelated candidates fail", async () => {
    const source = observation("s", {
      conditions: [
        { id: "s1", description: "pile" },
        { id: "s2", description: "other pile" },
      ],
    });
    const candidates = Array.from({ length: 8 }, (_, i) =>
      observation(`c${i}`, {
        conditions: [{ id: `t${i}`, description: "pile" }],
      }),
    );
    /** @type {{conditionResults:import('./image-matcher.js').ConditionOutcome[]}[]} */ const progress =
      [];
    const result = await matchImages({
      source,
      candidates,
      exhaustive: true,
      onProgress: async (p) => {
        progress.push(globalThis.structuredClone(p));
      },
      compare: async (request) => {
        if (request.candidates.some((c) => c.id === "c4"))
          throw new Error("unrelated batch failed");
        return response(request);
      },
    });
    expect(progress[0].conditionResults[0].possibleDuplicate).toBe(true);
    expect(progress[0].conditionResults[1].status).toBe("pending");
    expect(result.conditionResults[0].possibleDuplicate).toBe(true);
    expect(result.conditionResults[0].assessmentOutcome).toBe("matched");
    expect(result.conditionResults[1].possibleDuplicate).toBeNull();
    expect(result.conditionResults[1].assessmentOutcome).toBe("incomplete");
    expect(result.possibleDuplicate).toBe(true);
    expect(result.status).toBe("incomplete");
    expect(result.latency.firstPositiveMs).not.toBeNull();
  });
  it("rejects cross-category model mappings even when both categories exist in the photo", async () => {
    const source = observation("s", {
      conditions: [
        { id: "s1", category: "Litter", description: "trash" },
        { id: "s2", category: "Graffiti", description: "tag" },
      ],
    });
    const candidate = observation("c", {
      conditions: [
        { id: "c1", category: "Litter", description: "trash" },
        { id: "c2", category: "Graffiti", description: "tag" },
      ],
    });
    const result = await matchImages({
      source,
      candidates: [candidate],
      compare: async (request) => {
        const value = response(request);
        if (request.mode === "context")
          value.comparisons[0].condition_matches[0].candidate_condition_id =
            "c2";
        return value;
      },
    });
    expect(result.status).toBe("incomplete");
    expect(result.possibleDuplicate).toBeNull();
  });
  it("excludes categories before any model call and leaves missing categories unknown", async () => {
    const source = observation("s", {
      conditions: [{ id: "s1", category: "Litter", description: "trash" }],
    });
    const result = await matchImages({
      source,
      candidates: [
        observation("c", {
          conditions: [{ id: "c1", category: "Graffiti", description: "tag" }],
        }),
      ],
      compare: async () => {
        throw new Error("Must not call");
      },
    });
    expect(result.calls).toBe(0);
    expect(result.conditionResults[0].possibleDuplicate).toBe(false);
    const unknown = await matchImages({
      source: observation("s", {
        conditions: [{ id: "s1", category: undefined, description: "trash" }],
      }),
      candidates: [],
      compare: async () => {
        throw new Error("Must not call");
      },
    });
    expect(unknown.possibleDuplicate).toBeNull();
  });
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
    ).toBe("high");
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
    expect(result.conditionResults[0].possibleDuplicate).toBe(false);
    expect(result.possibleDuplicate).toBe(false);
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
    expect(result.possibleDuplicate).toBe(false);
    expect(result.conditionResults[0].possibleDuplicate).toBe(false);
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
    expect(result.possibleDuplicate).toBe(false);
    expect(result.conditionResults[0].possibleDuplicate).toBe(false);
  });
  it("does not flag media with no analyzer issues as a duplicate", async () => {
    const result = await matchImages({
      source: observation("s", { conditions: [] }),
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
    expect(normal.assessedCandidateCount).toBe(1);
    expect(exhaustive.assessedCandidateCount).toBe(9);
    expect(exhaustive.unassessedCandidateIds).toEqual([]);
  });
  it("enforces strict 72-hour boundary, availability, site and resolution", () => {
    const source = observation("source");
    const candidates = [
      observation("boundary", { observedAt: "2026-10-11T12:00:00.001Z" }),
      observation("old", { observedAt: "2026-10-11T12:00:00Z" }),
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
    expect(result.calls).toBe(9);
    expect(result.possibleDuplicate).toBe(false);
  });
  it("keeps failed or malformed assessments incomplete instead of publishing a negative", async () => {
    const source = observation("s");
    const result = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async () => {
        throw new Error("down");
      },
    });
    expect(result.status).toBe("incomplete");
    expect(result.possibleDuplicate).toBeNull();
    expect(result.unassessedCandidateIds).toEqual(["c"]);
    expect(result.conditionResults[0]).toMatchObject({
      assessmentOutcome: "incomplete",
      status: "insufficient_evidence",
      possibleDuplicate: null,
      failedCandidateCount: 1,
    });
    const malformed = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async () => ({
        comparison_version: "v1",
        model: { model_id: "m" },
        comparisons: [],
      }),
    });
    expect(malformed.status).toBe("incomplete");
    expect(malformed.conditionResults[0].assessmentOutcome).toBe("incomplete");
    const negative = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async (request) => response(request, "different_issue"),
    });
    expect(negative.conditionResults[0]).toMatchObject({
      possibleDuplicate: false,
      assessmentOutcome: "assessed_no_match",
      failedCandidateCount: 0,
    });
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
    expect(result.status).toBe("incomplete");
    expect(result.possibleDuplicate).toBeNull();
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
  expect(result.assessedCandidateCount).toBe(1);
  expect(result.unassessedCandidateIds).toHaveLength(8);
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

it("tries youngest first despite hashes, continues failures and stops each issue independently", async () => {
  const source = observation("s", {
    fingerprint: "same",
    conditions: [
      { id: "s1", description: "first" },
      { id: "s2", description: "second" },
    ],
  });
  const candidates = [
    observation("old", {
      observedAt: "2026-10-14T08:00:00Z",
      fingerprint: "same",
    }),
    observation("middle", { observedAt: "2026-10-14T10:00:00Z" }),
    observation("young", { observedAt: "2026-10-14T11:00:00Z" }),
    observation("failure", { observedAt: "2026-10-14T11:30:00Z" }),
  ];
  /** @type {string[]} */ const visited = [];
  /** @type {(string[]|undefined)[]} */ const sourceIds = [];
  const result = await matchImages({
    source,
    candidates,
    compare: async (request) => {
      if (request.mode === "image") visited.push(request.candidates[0].id);
      if (request.candidates[0].id === "failure") throw new Error("timeout");
      if (request.mode === "context")
        sourceIds.push(request.source.context?.conditions.map((c) => c.id));
      return response(request);
    },
  });
  expect(visited).toEqual(["failure", "young", "middle"]);
  expect(sourceIds).toEqual([["s1", "s2"], ["s2"]]);
  expect(
    result.conditionResults.map((c) => c.duplicateOf?.observationId),
  ).toEqual(["young", "middle"]);
  expect(result.failedCandidateIds).toEqual(["failure"]);
  expect(result.status).toBe("evaluated");
});

it("propagates publication errors so persistence failures retry", async () => {
  await expect(
    matchImages({
      source: observation("s"),
      candidates: [observation("c")],
      compare: async (request) => response(request),
      onProgress: async () => {
        throw new Error("database unavailable");
      },
    }),
  ).rejects.toThrow("database unavailable");
});

it("combined verification confirms image-backed issue IDs with an independent image pass", async () => {
  const result = await runMatcher({
    source: observation("s"),
    candidates: [observation("c")],
    compare: async (request) => {
      expect(request.output).toBe("compact");
      if (request.mode === "context")
        expect(request.source.context?.conditions).toHaveLength(1);
      else {
        expect(request.source.context).toBeUndefined();
        expect(request.source.id).toBe("c");
        expect(request.candidates[0].id).toBe("s");
      }
      return response(request);
    },
  });
  expect(result.calls).toBe(2);
  expect(result.possibleDuplicate).toBe(true);
  const uncertain = await runMatcher({
    source: observation("s", { observedAt: undefined }),
    candidates: [observation("c")],
    compare: async (r) => response(r),
  });
  expect(uncertain.possibleDuplicate).toBe(false);
  expect(uncertain.suggestions[0].confidence).toBe("medium");
});
it("fast-only misses remain pending, and background can recover a metadata mismatch", async () => {
  const source = observation("s", {
    conditions: [{ id: "s1", description: "wooden cabinet" }],
  });
  const candidates = [
    observation("deferred", {
      observedAt: "2026-10-14T11:59:00Z",
      conditions: [{ id: "c1", description: "cardboard box" }],
    }),
    ...Array.from({ length: 4 }, (_, i) =>
      observation(`c${i}`, {
        conditions: [{ id: `t${i}`, description: "wooden cabinet" }],
      }),
    ),
  ];
  /** @type {string[][]} */ const batches = [];
  /** @type {import('./image-matcher.js').Compare} */
  const compare = async (r) => {
    if (r.mode === "image" || r.purpose) return response(r);
    batches.push(r.candidates.map((c) => c.id));
    const value = response(r, "different_issue");
    const index = r.candidates.findIndex((c) => c.id === "deferred");
    if (index >= 0)
      value.comparisons[index] = response({
        ...r,
        candidates: [r.candidates[index]],
      }).comparisons[0];
    return value;
  };
  const fast = await runMatcher({
    source,
    candidates,
    compare,
    fastOnly: true,
  });
  expect(batches).toEqual([["c0", "c1", "c2"]]);
  expect(fast.status).toBe("pending");
  expect(fast.conditionResults[0].possibleDuplicate).toBeNull();
  batches.length = 0;
  const full = await runMatcher({ source, candidates, compare });
  expect(batches[0]).toEqual(["c0", "c1", "c2"]);
  expect(full.conditionResults[0].duplicateOf?.observationId).toBe("deferred");
  expect(full.possibleDuplicate).toBe(true);
});
it("combined batches continue unmatched issues without re-assessing confirmed IDs", async () => {
  const source = observation("s", {
    conditions: [
      { id: "first", description: "one" },
      { id: "second", description: "two" },
    ],
  });
  const candidates = Array.from({ length: 6 }, (_, i) => observation(`c${i}`));
  /** @type {(string[]|undefined)[]} */ const ids = [];
  const result = await runMatcher({
    source,
    candidates,
    compare: async (r) => {
      if (r.mode === "context" && !r.purpose)
        ids.push(r.source.context?.conditions.map((c) => c.id));
      return response(r);
    },
  });
  expect(ids).toEqual([["first", "second"], ["second"]]);
  expect(
    result.conditionResults.every((c) => c.possibleDuplicate === true),
  ).toBe(true);
});

it("chooses the youngest qualifying target even if the model reverses its row order", async () => {
  const source = observation("s");
  const candidates = [
    observation("older", { observedAt: "2026-10-14T10:00:00Z" }),
    observation("younger", { observedAt: "2026-10-14T11:00:00Z" }),
  ];
  const result = await runMatcher({
    source,
    candidates,
    compare: async (r) => {
      const value = response(r);
      value.comparisons.reverse();
      return value;
    },
  });
  expect(result.conditionResults[0].duplicateOf?.observationId).toBe("younger");
});

it("text identity needs identifying correspondences without unresolved contradictions", () => {
  const evidence = {
    identity_basis: "text",
    text_identity: "clear",
    visual_identity: "unclear",
    issue_mapping: "clear",
    matching_features: ["blue sofa", "north entrance beside numbered gate"],
    visible_differences: [],
    contradictions: [],
    description_conflict: "none",
    continuity_concern: "none",
  };
  expect(assessConfidence("same_issue", evidence).confidence).toBe("high");
  expect(
    assessConfidence("same_issue", {
      ...evidence,
      matching_features: ["litter"],
    }).confidence,
  ).toBe("low");
  expect(
    assessConfidence("same_issue", {
      ...evidence,
      contradictions: ["south entrance"],
    }).confidence,
  ).toBe("low");
  expect(
    assessConfidence("same_issue", {
      ...evidence,
      continuity_concern: "unknown",
    }).confidence,
  ).toBe("high");
});

it("retains recurrence safeguards while allowing unknown lifecycle history", () => {
  const evidence = {
    visual_identity: "clear",
    issue_mapping: "clear",
    matching_features: ["Matching blue stripes and broken left handle"],
    visible_differences: [],
    contradictions: [],
    description_conflict: "none",
    continuity_concern: "unknown",
  };
  expect(assessConfidence("same_issue", evidence).confidence).toBe("high");
  expect(
    assessConfidence("same_issue", {
      ...evidence,
      continuity_concern: "possible_resolution_or_recurrence",
    }).confidence,
  ).toBe("medium");
});

it("does not expose source issues with no same-category target in the batch", async () => {
  await matchImages({
    source: observation("s", {
      conditions: [
        { id: "s1", category: "Bulky items", description: "cabinet" },
        { id: "s2", category: "Tents", description: "tarp" },
      ],
    }),
    candidates: [
      observation("c", {
        conditions: [
          { id: "c1", category: "Bulky items", description: "cabinet" },
        ],
      }),
    ],
    compare: async (request) => {
      expect(request.source.context?.conditions?.map((c) => c.id)).toEqual([
        "s1",
      ]);
      return response(request);
    },
  });
});

it("continues a 12-candidate search after a failed three-candidate batch and recovers on a fresh evaluation", async () => {
  const source = observation("s");
  const candidates = Array.from({ length: 12 }, (_, i) => observation(`c${i}`));
  let requests = 0;
  const incomplete = await runMatcher({
    source,
    candidates,
    strategy: "combined",
    compare: async (request) => {
      requests++;
      if (requests === 2) throw new Error("Comparison HTTP 422");
      return response(request, "different_issue");
    },
  });
  expect(requests).toBe(4);
  expect(incomplete).toMatchObject({
    status: "incomplete",
    possibleDuplicate: null,
    candidateCount: 12,
    assessedCandidateCount: 9,
    calls: 4,
  });
  expect(incomplete.failedCandidateIds).toHaveLength(3);
  const shortlisted = markUnassessedCandidates(incomplete, candidates);
  expect(shortlisted.status).toBe("incomplete");
  expect(shortlisted.unassessedCandidateIds).toHaveLength(3);
  expect([...incomplete.unassessedCandidateIds].sort()).toEqual(
    [...incomplete.failedCandidateIds].sort(),
  );
  expect(incomplete.conditionResults[0]).toMatchObject({
    assessmentOutcome: "incomplete",
    possibleDuplicate: null,
    failedCandidateCount: 3,
  });
  const recovered = await runMatcher({
    source,
    candidates,
    strategy: "combined",
    compare: async (request) => response(request, "different_issue"),
  });
  expect(recovered).toMatchObject({
    status: "evaluated",
    possibleDuplicate: false,
    candidateCount: 12,
    assessedCandidateCount: 12,
  });
  expect(recovered.failedCandidateIds).toEqual([]);
  expect(recovered.unassessedCandidateIds).toEqual([]);
});

it("limits incomplete coverage to conditions in the failed candidate's category", async () => {
  const result = await matchImages({
    source: observation("s", {
      conditions: [
        { id: "litter", description: "cup", category: "Litter" },
        { id: "graffiti", description: "tag", category: "Graffiti" },
      ],
    }),
    candidates: [
      observation("failed", {
        conditions: [{ id: "cup", description: "cup", category: "Litter" }],
      }),
      observation("assessed", {
        conditions: [{ id: "tag", description: "tag", category: "Graffiti" }],
      }),
    ],
    compare: async (request) => {
      if (request.candidates[0].id === "failed")
        throw new Error("Comparison HTTP 422");
      return response(request, "different_issue");
    },
  });
  expect(result.conditionResults).toMatchObject([
    {
      conditionId: "litter",
      possibleDuplicate: null,
      assessmentOutcome: "incomplete",
      failedCandidateCount: 1,
    },
    {
      conditionId: "graffiti",
      possibleDuplicate: false,
      assessmentOutcome: "assessed_no_match",
      failedCandidateCount: 0,
    },
  ]);
});

describe("distinctive evidence required for a confirmed duplicate", () => {
  for (const generic of [
    "Litter on the sidewalk",
    "Scattered litter on the sidewalk",
    "SAME GRAFFITI ON THE BUILDING!",
    "Distinctive object",
  ]) {
    it(`does not promote generic support: ${generic}`, () => {
      const evidence = response({
        mode: "context",
        source: { id: "s" },
        candidates: [{ id: "c" }],
      }).comparisons[0].evidence;
      expect(
        assessConfidence("same_issue", {
          ...evidence,
          matching_features: [generic],
        }).confidence,
      ).toBe("low");
    });
  }

  it("continues searching after a batch of generic positives and publishes only the grounded match", async () => {
    const source = observation("source");
    const candidates = [
      "generic-0",
      "generic-1",
      "generic-2",
      "positive-last",
    ].map((id) => observation(id));
    /** @type {import("./image-matcher.js").ConditionOutcome[][]} */
    const publications = [];
    let calls = 0;
    const result = await runMatcher({
      source,
      candidates,
      strategy: "combined",
      compare: async (request) => {
        calls++;
        const result = response(request);
        for (const row of result.comparisons) {
          const features = row.candidate_id.startsWith("generic")
            ? ["Both images show litter on the sidewalk"]
            : ["Blue crate with broken left handle"];
          row.evidence.matching_features = features;
          for (const pair of row.condition_matches)
            pair.evidence.matching_features = features;
        }
        return result;
      },
      onProgress: async (progress) => {
        publications.push(progress.conditionResults);
      },
    });
    expect(calls).toBe(3);
    expect(result.possibleDuplicate).toBe(true);
    expect(result.conditionResults[0].duplicateOf?.observationId).toBe(
      "positive-last",
    );
    expect(publications[0].every((row) => row.possibleDuplicate !== true)).toBe(
      true,
    );
  });

  it("requires distinctive support on the issue mapping as well as the candidate", async () => {
    const source = observation("source");
    const result = await runMatcher({
      source,
      candidates: [observation("candidate")],
      compare: async (request) => {
        const result = response(request);
        for (const row of result.comparisons)
          for (const pair of row.condition_matches)
            pair.evidence.matching_features = [
              "Scattered litter on the sidewalk",
            ];
        return result;
      },
    });
    expect(result.possibleDuplicate).toBe(false);
    expect(result.conditionResults[0].duplicateOf).toBeNull();
  });

  it("retains genuine identifying evidence alongside generic context", () => {
    const evidence = response({
      mode: "context",
      source: { id: "s" },
      candidates: [{ id: "c" }],
    }).comparisons[0].evidence;
    expect(
      assessConfidence("same_issue", {
        ...evidence,
        matching_features: [
          "Litter on the sidewalk",
          "Blue crate with broken left handle beside gate G7",
        ],
      }).confidence,
    ).toBe("high");
  });
});

it("does not publish a description-copying positive rejected by the independent images", async () => {
  /** @type {import("./image-matcher.js").ComparisonRequest[]} */
  const requests = [];
  /** @type {import("./image-matcher.js").ConditionOutcome[]} */
  const published = [];
  const result = await runMatcher({
    source: observation("source"),
    candidates: [observation("candidate")],
    compare: async (request) => {
      requests.push(request);
      const value = response(
        request,
        request.purpose === "visual_verification"
          ? "different_issue"
          : "same_issue",
      );
      if (!request.purpose) {
        value.comparisons[0].evidence.matching_features = [
          "Green beverage bottle upright beside the curb",
        ];
        value.comparisons[0].condition_matches[0].evidence.matching_features = [
          "Green beverage bottle upright beside the curb",
        ];
      }
      return value;
    },
    onProgress: async (progress) => {
      published.push(
        ...progress.conditionResults.filter(
          (row) => row.possibleDuplicate === true,
        ),
      );
    },
  });
  expect(requests.map((r) => r.mode)).toEqual(["context", "context"]);
  expect(requests[1].source.id).toBe("candidate");
  expect(requests[1].candidates[0].id).toBe("source");
  expect(requests[1].purpose).toBe("visual_verification");
  expect(Object.keys(requests[1].source.context ?? {})).toEqual(["conditions"]);
  expect(requests[1].source.context?.conditions).toHaveLength(1);
  expect(requests[1].candidates[0].context?.conditions).toHaveLength(1);
  expect(result.possibleDuplicate).toBe(false);
  expect(result.comparisons[0].stageDisagreement).toBe(true);
  expect(result.comparisons[0].visualVerifications?.[0].verdict).toBe(
    "different_issue",
  );
  expect(published).toHaveLength(0);
});

it("keeps a failed independent image check incomplete instead of publishing a positive or a negative", async () => {
  const result = await runMatcher({
    source: observation("source"),
    candidates: [observation("candidate")],
    compare: async (request) => {
      if (request.purpose === "visual_verification")
        throw new Error("verification unavailable");
      return response(request);
    },
  });
  expect(result.status).toBe("incomplete");
  expect(result.possibleDuplicate).toBeNull();
  expect(result.failedCandidateIds).toEqual(["candidate"]);
});

it("corroborates only the required positive instead of verifying every same-condition suggestion", async () => {
  /** @type {string[]} */
  const modes = [];
  const result = await runMatcher({
    source: observation("source"),
    candidates: [observation("a"), observation("b"), observation("c")],
    compare: async (request) => {
      modes.push(request.mode);
      return response(request);
    },
  });
  expect(result.possibleDuplicate).toBe(true);
  expect(modes).toEqual(["context", "context"]);
  expect(
    result.comparisons.filter((row) => row.confidence === "high"),
  ).toHaveLength(1);
});

it("keeps searching after a failed visual corroboration and finds a later real match", async () => {
  /** @type {(string|undefined)[]} */
  const published = [];
  const result = await runMatcher({
    source: observation("source"),
    candidates: ["a-false", "b-no", "c-no", "d-real"].map((id) =>
      observation(id),
    ),
    compare: async (request) => {
      if (request.purpose === "visual_verification")
        return response(
          request,
          request.source.id === "a-false" ? "different_issue" : "same_issue",
        );
      const value = response(request, "different_issue");
      for (let i = 0; i < request.candidates.length; i++)
        if (["a-false", "d-real"].includes(request.candidates[i].id))
          value.comparisons[i] = response({
            ...request,
            candidates: [request.candidates[i]],
          }).comparisons[0];
      return value;
    },
    onProgress: async (progress) => {
      published.push(
        ...progress.conditionResults
          .filter((r) => r.possibleDuplicate === true)
          .map((r) => r.duplicateOf?.observationId),
      );
    },
  });
  expect(result.calls).toBe(4);
  expect(result.conditionResults[0].duplicateOf?.observationId).toBe("d-real");
  expect(published).toEqual(["d-real"]);
});

it.each([
  "no-mapping",
  "wrong-pair",
  "unrelated-only",
  "weak-mapping",
  "uncertain",
])(
  "does not corroborate the target issue from unrelated visual agreement: %s",
  async (kind) => {
    /** @type {import("./image-matcher.js").ConditionOutcome[]} */
    const publications = [];
    const result = await runMatcher({
      source: observation("source"),
      candidates: [observation("candidate")],
      compare: async (request) => {
        const value = response(request);
        if (request.purpose) {
          if (kind === "uncertain") return response(request, "uncertain");
          const row = value.comparisons[0];
          row.evidence.matching_features = ["Blue graffiti tag on gate"];
          if (kind === "no-mapping") {
            row.condition_matches = [];
            row.evidence.issue_mapping = "none";
          }
          if (kind === "wrong-pair")
            row.condition_matches[0].source_condition_id =
              "other-shared-graffiti";
          if (kind === "unrelated-only")
            row.condition_matches[0].evidence.issue_mapping = "ambiguous";
          if (kind === "weak-mapping")
            row.condition_matches[0].evidence.matching_features = [
              "Litter on sidewalk",
            ];
        }
        return value;
      },
      onProgress: async (p) => {
        publications.push(
          ...p.conditionResults.filter((c) => c.possibleDuplicate === true),
        );
      },
    });
    expect(result.possibleDuplicate).not.toBe(true);
    expect(publications).toHaveLength(0);
  },
);

it("corroborates each condition pair independently and does not promote other mappings in the same photo", async () => {
  const source = observation("source", {
    conditions: [
      { id: "s1", description: "Blue crate" },
      { id: "s2", description: "Paper cup" },
    ],
  });
  const target = observation("candidate", {
    conditions: [
      { id: "t1", description: "Blue crate" },
      { id: "t2", description: "Paper cup" },
    ],
  });
  /** @type {import("./image-matcher.js").ComparisonRequest[]} */
  const requests = [];
  const result = await runMatcher({
    source,
    candidates: [target],
    compare: async (request) => {
      const value = response(request);
      if (request.purpose) {
        requests.push(request);
        if (request.source.context?.conditions[0].id === "t2")
          return response(request, "different_issue");
      } else {
        const row = value.comparisons[0];
        row.condition_matches = [
          {
            ...row.condition_matches[0],
            source_condition_id: "s1",
            candidate_condition_id: "t1",
          },
          {
            ...row.condition_matches[0],
            source_condition_id: "s2",
            candidate_condition_id: "t2",
          },
        ];
      }
      return value;
    },
  });
  expect(requests).toHaveLength(2);
  expect(
    requests.map((r) => r.source.context?.conditions.map((c) => c.id)),
  ).toEqual([["t1"], ["t2"]]);
  expect(
    requests.map((r) => r.candidates[0].context?.conditions.map((c) => c.id)),
  ).toEqual([["s1"], ["s2"]]);
  expect(
    result.conditionResults.find((c) => c.conditionId === "s1")
      ?.possibleDuplicate,
  ).toBe(true);
  expect(
    result.conditionResults.find((c) => c.conditionId === "s2")
      ?.possibleDuplicate,
  ).toBe(false);
  expect(result.comparisons[0].visualVerifications).toHaveLength(2);
});

it.each(["A-12", "G7", "Identifier: 12345"])(
  "retains explicit physical marking %s as identifying evidence",
  (marking) => {
    const e = response({
      mode: "context",
      source: { id: "s" },
      candidates: [{ id: "c" }],
    }).comparisons[0].evidence;
    expect(
      assessConfidence("same_issue", { ...e, matching_features: [marking] })
        .confidence,
    ).toBe("high");
  },
);
it.each([
  "12345",
  "2026-10-27",
  "3 scattered paper items",
  "Litter on sidewalk",
])("does not use generic quantities or dates as identity: %s", (feature) => {
  const e = response({
    mode: "context",
    source: { id: "s" },
    candidates: [{ id: "c" }],
  }).comparisons[0].evidence;
  expect(
    assessConfidence("same_issue", { ...e, matching_features: [feature] })
      .confidence,
  ).toBe("low");
});
