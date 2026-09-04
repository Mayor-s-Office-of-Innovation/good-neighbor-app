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
