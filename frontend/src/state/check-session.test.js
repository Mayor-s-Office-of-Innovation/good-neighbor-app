import { beforeEach, describe, expect, it, vi } from "vitest";

let savedReview = null;
let nextId = 1;

const TEST_PLACES = [{ id: "place-north", name: "North" }];

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

describe("legacy review records", () => {
  // Pre-#192 devices may still carry review-store records with legacy-stage
  // statuses (uploading/analyzing/submitted). No code path produces those
  // statuses anymore; today-view's connectedCallback clears any session that
  // is not capture-complete instead of letting it linger.
  let nextLegacyId = 1;

  beforeEach(async () => {
    savedReview = null;
    nextLegacyId = 1;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("clears every legacy-stage status via clearSubmittedSession", async () => {
    for (const status of [
      "uploading",
      "analyzing",
      "submitted",
      "analysis_failed",
    ]) {
      const { startCheck, markCaptureComplete, clearSubmittedSession } =
        await import("./check-session.js");

      // Seed a legacy-stage record the way the batch pipeline used to.
      startCheck("site-1", TEST_PLACES);
      vi.mocked(startCheck).mock; // no-op; startCheck returns the session
      const id = `chk_legacy_${nextLegacyId++}_${status}`;
      startCheck("site-1", TEST_PLACES);
      // Force the status directly: these values are unreachable via the
      // module's own mutators now, so write through the hydrated copy.
      const session = /** @type {any} */ (
        await (async () => {
          const mod = await import("./check-session.js");
          return mod.getCurrentCheck();
        })()
      );
      session.id = id;
      session.status = status;
      const { persistReviewForTest } = /** @type {any} */ (
        await import("./check-session.js")
      );
      if (persistReviewForTest) persistReviewForTest();
      else {
        // Fall back: mirror the record into the mocked review store directly.
        savedReview = session;
      }

      // The connectedCallback predicate: not capture-complete → clear.
      const loaded = await (
        await import("./check-session.js")
      ).loadSubmitted();
      if (loaded && loaded.status !== "capture-complete") {
        await clearSubmittedSession();
      }
      expect(
        await (await import("./check-session.js")).loadSubmitted(),
      ).toBeNull();
      expect(savedReview).toBeNull();
    }
  });
});