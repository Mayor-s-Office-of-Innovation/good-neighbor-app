import { beforeEach, describe, expect, it, vi } from "vitest";

let savedReview = null;
let nextId = 1;

vi.mock("../db.js", () => ({
  newId: () => `test-check-id-${nextId++}`,
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  getDraft: vi.fn(async () => null),
  saveReview: vi.fn((check) => {
    savedReview = check;
    return Promise.resolve(check);
  }),
  getReview: vi.fn(async () => savedReview),
  clearReview: vi.fn(async () => {
    savedReview = null;
  }),
}));

describe("loadSubmitted", () => {
  beforeEach(async () => {
    savedReview = null;
    nextId = 1;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("does not overwrite a live in-progress check with a saved review session", async () => {
    const { loadSubmitted, startCheck, getCurrentCheck } = await import(
      "./check-session.js"
    );
    savedReview = {
      id: "old-review",
      status: "submitted",
      findings: [],
      assessment: {},
    };

    const active = startCheck("site-1");

    await expect(loadSubmitted()).resolves.toBeNull();
    expect(getCurrentCheck()).toBe(active);
    expect(getCurrentCheck()?.status).toBe("in-progress");
  });
});

describe("markAnalyzing", () => {
  beforeEach(async () => {
    savedReview = null;
    nextId = 1;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("persists the expected artifact count for resumed finalization", async () => {
    const { getCurrentCheck, markAnalyzing, startCheck } = await import(
      "./check-session.js"
    );

    startCheck("site-1");
    markAnalyzing({ expectedArtifacts: 4 });

    expect(getCurrentCheck()?.expectedArtifacts).toBe(4);
    expect(savedReview?.expectedArtifacts).toBe(4);
  });

  it("ignores a stale checkId when the active session has been replaced", async () => {
    const { getCurrentCheck, markAnalyzing, startCheck } = await import(
      "./check-session.js"
    );

    const original = startCheck("site-1");
    startCheck("site-2");
    markAnalyzing({ checkId: original.id, expectedArtifacts: 4 });

    expect(getCurrentCheck()?.id).not.toBe(original.id);
    expect(getCurrentCheck()?.status).toBe("in-progress");
    expect(savedReview).toBeNull();
  });
});
