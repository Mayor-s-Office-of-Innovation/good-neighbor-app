import { beforeEach, describe, expect, it, vi } from "vitest";

let savedReview = null;

vi.mock("../db.js", () => ({
  newId: () => "test-check-id",
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
