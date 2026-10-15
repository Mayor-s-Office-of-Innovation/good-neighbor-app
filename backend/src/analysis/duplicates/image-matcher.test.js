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
    expect(result.conditionResults[1].possibleDuplicate).toBe(false);
    expect(result.possibleDuplicate).toBe(true);
    expect(result.status).toBe("evaluated");
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
    expect(result.status).toBe("evaluated");
    expect(result.possibleDuplicate).toBe(false);
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
  it("returns no qualifying match after failed or malformed attempts", async () => {
    const source = observation("s");
    const result = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async () => {
        throw new Error("down");
      },
    });
    expect(result.status).toBe("evaluated");
    expect(result.possibleDuplicate).toBe(false);
    const malformed = await matchImages({
      source,
      candidates: [observation("c")],
      compare: async () => ({
        comparison_version: "v1",
        model: { model_id: "m" },
        comparisons: [],
      }),
    });
    expect(malformed.status).toBe("evaluated");
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
    expect(result.status).toBe("evaluated");
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

it("combined verification maps explicit issue IDs in one call and retains safeguards", async () => {
  const result = await runMatcher({
    source: observation("s"),
    candidates: [observation("c")],
    compare: async (request) => {
      expect(request.mode).toBe("context");
      expect(request.output).toBe("compact");
      expect(request.source.context?.conditions).toHaveLength(1);
      return response(request);
    },
  });
  expect(result.calls).toBe(1);
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
    matching_features: ["Distinctive markings and arrangement"],
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
