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

    const active = startCheck("site-1", TEST_PLACES);

    await expect(loadSubmitted()).resolves.toBeNull();
    expect(getCurrentCheck()).toBe(active);
    expect(getCurrentCheck()?.status).toBe("in-progress");
  });
});

describe("eager-upload item mutators", () => {
  beforeEach(async () => {
    savedReview = null;
    nextId = 1;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("markItemUploaded stores artifact coords and swaps in the thumbnail", async () => {
    const { startCheck, addItem, markItemUploaded, getCurrentCheck } =
      await import("./check-session.js");

    startCheck("site-1", TEST_PLACES);
    const item = addItem("place-north", {
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,FULLRES==",
    });

    markItemUploaded("place-north", item.id, {
      artifactId: "art-1",
      s3Key: "checks/site/c/art-1.jpg",
      contentType: "image/jpeg",
      thumbUrl: "data:image/jpeg;base64,THUMB==",
    });

    const stored = getCurrentCheck().places["place-north"].items[0];
    expect(stored.upload).toEqual({
      status: "uploaded",
      artifactId: "art-1",
      s3Key: "checks/site/c/art-1.jpg",
      contentType: "image/jpeg",
    });
    expect(stored.dataUrl).toBe("data:image/jpeg;base64,THUMB==");
  });

  it("setItemUploadStatus keeps the full-res dataUrl for the submit fallback", async () => {
    const { startCheck, addItem, setItemUploadStatus, getCurrentCheck } =
      await import("./check-session.js");

    startCheck("site-1", TEST_PLACES);
    const item = addItem("place-north", {
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,FULLRES==",
    });

    setItemUploadStatus("place-north", item.id, "failed");

    const stored = getCurrentCheck().places["place-north"].items[0];
    expect(stored.upload.status).toBe("failed");
    expect(stored.dataUrl).toBe("data:image/jpeg;base64,FULLRES==");
  });

  it("no-ops when the item was deleted mid-upload", async () => {
    const { startCheck, addItem, removeItem, markItemUploaded } = await import(
      "./check-session.js"
    );

    startCheck("site-1", TEST_PLACES);
    const item = addItem("place-north", { kind: "photo", dataUrl: "data:,x" });
    removeItem("place-north", item.id);

    expect(
      markItemUploaded("place-north", item.id, {
        artifactId: "art-1",
        s3Key: "k",
        contentType: "image/jpeg",
        thumbUrl: "t",
      }),
    ).toBeNull();
  });

  it("preserves the upload field through a draft rehydrate", async () => {
    const db = await import("../db.js");
    const {
      startCheck,
      addItem,
      markItemUploaded,
      clearCheck,
      loadDraft,
      getCurrentCheck,
    } = await import("./check-session.js");

    startCheck("site-1", TEST_PLACES);
    const item = addItem("place-north", {
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,FULLRES==",
    });
    markItemUploaded("place-north", item.id, {
      artifactId: "art-1",
      s3Key: "k",
      contentType: "image/jpeg",
      thumbUrl: "data:image/jpeg;base64,THUMB==",
    });

    // Capture what was mirrored to the draft store, then simulate a reload.
    const persisted = vi.mocked(db.saveDraft).mock.calls.at(-1)[0];
    vi.mocked(db.getDraft).mockResolvedValueOnce(
      JSON.parse(JSON.stringify(persisted)),
    );
    clearCheck();

    await loadDraft("perimeter");
    const rehydrated = getCurrentCheck().places["place-north"].items[0];
    expect(rehydrated.upload).toEqual({
      status: "uploaded",
      artifactId: "art-1",
      s3Key: "k",
      contentType: "image/jpeg",
    });
  });

  it("legacy analyzed items (no checkId stamps) still carry the session's checkId on resume", async () => {
    const db = await import("../db.js");
    const { startCheck, addItem, clearCheck, loadDraft, getCurrentCheck } =
      await import("./check-session.js");

    startCheck("site-1", TEST_PLACES);
    const realCheckId = getCurrentCheck().id;
    const item = addItem("place-north", { kind: "photo", dataUrl: "x" });
    // Simulate a LEGACY analyzed item: strip every checkId stamp this change
    // adds (item.checkId from addItem, analysis.checkId from the pipeline).
    const legacy = JSON.parse(
      JSON.stringify({
        ...item,
        checkId: undefined,
        analysis: {
          status: "analyzed",
          artifactId: "art-legacy",
          conditions: [],
          tasks: [],
        },
      }),
    );
    const persisted = {
      ...getCurrentCheck(),
      places: {
        ...getCurrentCheck().places,
        "place-north": {
          ...getCurrentCheck().places["place-north"],
          items: [legacy],
        },
      },
    };
    vi.mocked(db.getDraft).mockResolvedValueOnce(
      JSON.parse(JSON.stringify(persisted)),
    );
    clearCheck();

    await loadDraft("perimeter");
    const check = getCurrentCheck();
    // The resumed item still resolves its coordinates from the live session.
    expect(check.id).toBe(realCheckId);
    const resumed = check.places["place-north"].items[0];
    expect(resumed.analysis.artifactId).toBe("art-legacy");
    // The template's fallback chain must end at the session id, not "".
    expect(resumed.checkId ?? realCheckId).toBe(realCheckId);
  });

  it("reports a resumable perimeter draft without hydrating it", async () => {
    const db = await import("../db.js");
    const { hasDraft, getCurrentCheck } = await import("./check-session.js");
    vi.mocked(db.getDraft).mockResolvedValueOnce({
      id: "saved-check",
      siteId: "site-1",
      flowType: "perimeter",
      status: "in-progress",
      placeOrder: ["place-north"],
      places: {
        "place-north": {
          id: "place-north",
          name: "North",
          items: [],
        },
      },
    });

    await expect(hasDraft("perimeter")).resolves.toBe(true);
    expect(getCurrentCheck()).toBeNull();
  });

  it("resumes a perimeter draft instead of starting a fresh check", async () => {
    const db = await import("../db.js");
    const { resumeOrStartCheck, getCurrentCheck } = await import(
      "./check-session.js"
    );
    vi.mocked(db.getDraft).mockResolvedValueOnce({
      id: "saved-check",
      siteId: "site-1",
      flowType: "perimeter",
      status: "in-progress",
      activePlaceIndex: 1,
      placeList: [
        { id: "place-north", name: "North" },
        { id: "place-south", name: "South" },
      ],
      placeOrder: ["place-north", "place-south"],
      places: {
        "place-north": {
          id: "place-north",
          name: "North",
          items: [
            {
              id: "item-1",
              kind: "photo",
              analysis: {
                status: "analyzed",
                artifactId: "art-1",
                conditions: [{ label: "Litter" }],
              },
            },
          ],
        },
        "place-south": {
          id: "place-south",
          name: "South",
          items: [],
        },
      },
    });

    const resumed = await resumeOrStartCheck("site-1", TEST_PLACES);

    expect(resumed.id).toBe("saved-check");
    expect(resumed.activePlaceIndex).toBe(1);
    expect(
      getCurrentCheck().places["place-north"].items[0].analysis.artifactId,
    ).toBe("art-1");
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

    startCheck("site-1", TEST_PLACES);
    markAnalyzing({ expectedArtifacts: 4 });

    expect(getCurrentCheck()?.expectedArtifacts).toBe(4);
    expect(savedReview?.expectedArtifacts).toBe(4);
  });

  it("ignores a stale checkId when the active session has been replaced", async () => {
    const { getCurrentCheck, markAnalyzing, startCheck } = await import(
      "./check-session.js"
    );

    const original = startCheck("site-1", TEST_PLACES);
    startCheck("site-2", TEST_PLACES);
    markAnalyzing({ checkId: original.id, expectedArtifacts: 4 });

    expect(getCurrentCheck()?.id).not.toBe(original.id);
    expect(getCurrentCheck()?.status).toBe("in-progress");
    expect(savedReview).toBeNull();
  });
});

describe("markCaptureComplete", () => {
  beforeEach(async () => {
    savedReview = null;
    nextId = 1;
    const { clearCheck } = await import("./check-session.js");
    clearCheck();
    vi.clearAllMocks();
  });

  it("persists later analysis updates to the review-backed home session", async () => {
    const db = await import("../db.js");
    const {
      startCheck,
      addItem,
      markCaptureComplete,
      updateItemAnalysis,
      getCurrentCheck,
    } = await import("./check-session.js");

    startCheck("site-1", TEST_PLACES);
    const item = addItem("place-north", {
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,THUMB==",
    });
    markCaptureComplete({ checkId: getCurrentCheck().id });
    vi.mocked(db.saveDraft).mockClear();
    vi.mocked(db.saveReview).mockClear();

    updateItemAnalysis("place-north", item.id, {
      status: "analyzed",
      artifactId: "art-1",
      conditions: [{ conditionId: "cond-1", category: "Litter" }],
      tasks: [{ taskId: "task-1", conditionId: "cond-1" }],
    });

    expect(db.saveDraft).not.toHaveBeenCalled();
    expect(db.saveReview).toHaveBeenCalled();
    expect(savedReview?.places["place-north"].items[0].analysis.status).toBe(
      "analyzed",
    );
  });

  it("persists expected artifact coverage when capture completes", async () => {
    const { startCheck, markCaptureComplete, getCurrentCheck } = await import(
      "./check-session.js"
    );

    startCheck("site-1", TEST_PLACES);
    const checkId = getCurrentCheck().id;
    markCaptureComplete({ checkId, expectedArtifacts: 2 });

    expect(savedReview?.status).toBe("capture-complete");
    expect(savedReview?.expectedArtifacts).toBe(2);
  });
});
