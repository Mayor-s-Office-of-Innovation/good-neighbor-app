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
  beforeEach(async () => {
    savedReview = null;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("clears every legacy-stage status via clearSubmittedSession", async () => {
    const {
      startCheck,
      getCurrentCheck,
      loadSubmitted,
      clearSubmittedSession,
    } = await import("./check-session.js");

    for (const status of [
      "uploading",
      "analyzing",
      "submitted",
      "analysis_failed",
    ]) {
      // Seed a legacy-stage record: start a check, then force the status.
      // These values are unreachable via the module's own mutators now, so
      // the write has to go through the session object directly.
      startCheck("site-1", TEST_PLACES);
      const session = /** @type {any} */ (getCurrentCheck());
      session.status = status;
      savedReview = session;

      // The connectedCallback predicate: not capture-complete → clear.
      const loaded = await loadSubmitted();
      if (loaded && loaded.status !== "capture-complete") {
        await clearSubmittedSession();
      }
      expect(await loadSubmitted()).toBeNull();
      expect(savedReview).toBeNull();
    }
  });
});
