import { beforeEach, describe, expect, it, vi } from "vitest";

let savedReview = null;
let nextId = 1;

vi.mock("../db.js", () => ({
  newId: () => `test-check-id-${nextId++}`,
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  getDraft: vi.fn(async () => null),
  saveFinishedCheck: vi.fn((check) => {
    savedReview = check;
    return Promise.resolve(check);
  }),
  listFinishedChecks: vi.fn(async () => (savedReview ? [savedReview] : [])),
  deleteFinishedCheck: vi.fn(async () => {
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
      startCheck("site-1");
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

describe("evidence items", () => {
  beforeEach(async () => {
    savedReview = null;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("persists starting guidance and ignores a stale session response", async () => {
    const { startCheck, setCaptureGuidanceContext, getCurrentCheck } =
      await import("./check-session.js");
    const { saveDraft } = await import("../db.js");
    const check = startCheck("site-1");
    setCaptureGuidanceContext(check.id, { titleKey: "check.title.third" });
    expect(getCurrentCheck().captureGuidanceContext).toEqual({
      titleKey: "check.title.third",
    });
    expect(saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        captureGuidanceContext: { titleKey: "check.title.third" },
      }),
    );
    setCaptureGuidanceContext("old-check", {
      titleKey: "check.title.fourDays",
    });
    expect(getCurrentCheck().captureGuidanceContext.titleKey).toBe(
      "check.title.third",
    );
  });

  it("adds, updates, and removes items by id alone", async () => {
    const { startCheck, addItem, updateItem, updateItemAnalysis, removeItem } =
      await import("./check-session.js");
    const { getItems, findItem } = await import("./check-session.js");

    const check = startCheck("site-1");
    expect(check.items).toEqual([]);
    expect(check).not.toHaveProperty("places");

    const photo = addItem({ kind: "photo", dataUrl: "data:," });
    const text = addItem({ kind: "text", text: "The block is clear." });
    expect(photo).toMatchObject({ kind: "photo", checkId: check.id });
    expect(photo).not.toHaveProperty("placeId");
    expect(getItems().map((item) => item.id)).toEqual([photo.id, text.id]);

    updateItem(text.id, { upload: { status: "uploaded" } });
    updateItemAnalysis(photo.id, { status: "queued" });
    expect(findItem(text.id).upload).toEqual({ status: "uploaded" });
    expect(findItem(photo.id).analysis).toEqual({ status: "queued" });

    removeItem(photo.id);
    expect(getItems().map((item) => item.id)).toEqual([text.id]);
    expect(findItem(photo.id)).toBeNull();
  });
});

describe("pre-Phase-2 records (places map)", () => {
  // Drafts and review records persisted before the place layer was removed
  // keep evidence under `places[placeId].items`. Loading one must flatten it
  // into `items[]` so a device mid-walk at deploy time resumes cleanly.
  beforeEach(async () => {
    savedReview = null;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  const legacyDraft = () => ({
    id: "legacy-check",
    siteId: "site-1",
    flowType: "perimeter",
    window: "morning",
    startedAt: "2026-09-20T09:00:00.000Z",
    status: "in-progress",
    activePlaceIndex: 1,
    placeOrder: ["north", "south"],
    places: {
      south: {
        id: "south",
        name: "South",
        skipped: false,
        description: null,
        items: [
          { id: "s1", kind: "photo", placeId: "south", placeName: "South" },
        ],
      },
      north: {
        id: "north",
        name: "North",
        items: [
          {
            id: "n1",
            kind: "text",
            text: "Sidewalk clear.",
            placeId: "north",
            placeName: "North",
          },
          { id: "n2", kind: "photo", placeId: "north", placeName: "North" },
        ],
      },
      // Not in placeOrder: its evidence must still survive.
      orphan: { id: "orphan", name: "Orphan", items: [{ id: "o1" }] },
    },
    analyzingOpen: 1,
  });

  it("flattens a places draft into items[] in place order on loadDraft", async () => {
    const { getDraft } = await import("../db.js");
    vi.mocked(getDraft).mockResolvedValueOnce(legacyDraft());
    const { loadDraft, getItems, findItem, updateItemAnalysis, removeItem } =
      await import("./check-session.js");

    const check = /** @type {any} */ (await loadDraft("perimeter"));

    expect(check.id).toBe("legacy-check");
    expect(check.items.map((item) => item.id)).toEqual([
      "n1",
      "n2",
      "s1",
      "o1",
    ]);
    expect(check).not.toHaveProperty("places");
    expect(check).not.toHaveProperty("placeOrder");
    expect(check).not.toHaveProperty("activePlaceIndex");
    expect(check.analyzingOpen).toBe(true);
    // Legacy items keep the fields they were written with: an old place name
    // still labels its card.
    expect(findItem("n1").placeName).toBe("North");

    // Every mutation now keys on the item id alone.
    updateItemAnalysis("s1", { status: "analyzed" });
    expect(findItem("s1").analysis).toEqual({ status: "analyzed" });
    removeItem("n2");
    expect(getItems().map((item) => item.id)).toEqual(["n1", "s1", "o1"]);
  });

  it("normalizes a places review record on loadSubmitted", async () => {
    savedReview = {
      id: "legacy-review",
      flowType: "single-problem",
      status: "capture-complete",
      placeOrder: ["problem"],
      places: {
        problem: {
          id: "problem",
          name: "Problem",
          items: [{ id: "p1", kind: "photo" }],
        },
      },
    };
    const { loadSubmitted } = await import("./check-session.js");

    const check = /** @type {any} */ (await loadSubmitted());

    expect(check.status).toBe("capture-complete");
    expect(check.items.map((item) => item.id)).toEqual(["p1"]);
    expect(check).not.toHaveProperty("places");
  });

  it("leaves a current-shape draft as it is", async () => {
    const { getDraft } = await import("../db.js");
    vi.mocked(getDraft).mockResolvedValueOnce({
      id: "current-check",
      siteId: "site-1",
      flowType: "perimeter",
      status: "in-progress",
      items: [{ id: "a" }, { id: "b" }],
    });
    const { loadDraft } = await import("./check-session.js");

    const check = /** @type {any} */ (await loadDraft("perimeter"));

    expect(check.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(check.analyzingOpen).toBe(false);
  });
});

it("only finishing a perimeter check ends the install offer", async () => {
  const install = await import("../services/install-prompt.js");
  const { startCheck, clearCheck, markCaptureComplete, getCurrentCheck } =
    await import("./check-session.js");
  const completed = vi.fn();
  install.resetInstallPrompt();
  const unsubscribe = install.onFirstPerimeterCheckCompleted(completed);
  startCheck("site-1");
  expect(completed).not.toHaveBeenCalled();
  clearCheck();
  expect(completed).not.toHaveBeenCalled();
  startCheck("site-1");
  getCurrentCheck().flowType = "single-problem";
  markCaptureComplete({ submissionKind: "problem_report" });
  expect(completed).not.toHaveBeenCalled();
  clearCheck();
  startCheck("site-1");
  getCurrentCheck().flowType = "perimeter";
  markCaptureComplete({ submissionKind: "check" });
  expect(completed).toHaveBeenCalledTimes(1);
  unsubscribe();
  install.resetInstallPrompt();
});

describe("several finished checks", () => {
  // Checks finished offline wait on the device until they upload. Starting
  // another walk must keep the earlier one, and its upload progress must
  // keep saving to its own record.
  beforeEach(async () => {
    savedReview = null;
    const { discardInMemorySession } = await import("./check-session.js");
    discardInMemorySession();
    vi.clearAllMocks();
  });

  async function finishOne(note) {
    const session = await import("./check-session.js");
    const check = session.startCheck("site-1");
    const item = session.addItem({ kind: "text", text: note });
    session.markCaptureComplete({ checkId: check.id });
    return { check, item };
  }

  it("keeps a finished check when the next walk starts", async () => {
    const session = await import("./check-session.js");
    const { saveFinishedCheck } = await import("../db.js");
    const first = await finishOne("Litter by the gate");
    const second = await finishOne("Graffiti on the wall");

    expect(session.getCurrentCheck().id).toBe(second.check.id);
    expect(session.getCheck(first.check.id)).toBe(first.check);
    expect(session.findCheckForItem(first.item.id)).toBe(first.check);

    vi.mocked(saveFinishedCheck).mockClear();
    session.updateItemAnalysis(first.item.id, { status: "waiting" });
    expect(session.findItem(first.item.id).analysis.status).toBe("waiting");
    expect(saveFinishedCheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.check.id }),
    );
  });

  it("emits a background check's change with that check", async () => {
    const session = await import("./check-session.js");
    const first = await finishOne("Litter by the gate");
    await finishOne("Graffiti on the wall");
    const seen = [];
    const unsubscribe = session.onCheckSessionChange((check) =>
      seen.push(check?.id),
    );
    session.updateItem(first.item.id, { upload: { status: "uploaded" } });
    unsubscribe();
    expect(seen).toEqual([first.check.id]);
  });

  it("clearing the current check leaves the others waiting", async () => {
    const session = await import("./check-session.js");
    const { deleteFinishedCheck } = await import("../db.js");
    const first = await finishOne("Litter by the gate");
    const second = await finishOne("Graffiti on the wall");
    session.clearCheck();
    expect(deleteFinishedCheck).toHaveBeenCalledWith("site-1", second.check.id);
    expect(deleteFinishedCheck).not.toHaveBeenCalledWith(
      "site-1",
      first.check.id,
    );
    expect(session.getCheck(first.check.id)).toBe(first.check);
  });

  it("loadSubmitted returns the newest finished check during a walk", async () => {
    const session = await import("./check-session.js");
    const first = await finishOne("Litter by the gate");
    session.startCheck("site-1");
    expect((await session.loadSubmitted())?.id).toBe(first.check.id);
    expect(session.getCurrentCheck().status).toBe("in-progress");
  });

  it("marks a scorecard done once and persists it", async () => {
    const session = await import("./check-session.js");
    const { saveFinishedCheck } = await import("../db.js");
    const first = await finishOne("Litter by the gate");
    vi.mocked(saveFinishedCheck).mockClear();
    session.markScorecardDone(first.check.id);
    session.markScorecardDone(first.check.id);
    expect(first.check.scorecardDone).toBe(true);
    expect(saveFinishedCheck).toHaveBeenCalledTimes(1);
  });
});
