import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocked collaborators ─────────────────────────────────────────────────────
const presignArtifact = vi.fn();
const putMedia = vi.fn(async () => {});
const dataUrlToBlob = vi.fn(async () => new Blob(["x"]));
const contentTypeFromDataUrl = vi.fn(() => "image/jpeg");
const downscaleDataUrl = vi.fn(async () => "data:image/jpeg;base64,THUMB==");

class ApiError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.status = status;
  }
}

// A single live session object the uploader reads through getCurrentCheck. The
// mutators below mutate it so findItem() observes state changes across attempts.
let check;
const getCurrentCheck = vi.fn(() => check);
const markItemUploaded = vi.fn((side, itemId, coords) => {
  const it = check?.sides?.[side]?.items.find((i) => i.id === itemId);
  if (!it) return;
  it.upload = {
    status: "uploaded",
    artifactId: coords.artifactId,
    s3Key: coords.s3Key,
    contentType: coords.contentType,
  };
  if (coords.thumbUrl) it.dataUrl = coords.thumbUrl;
});
const setItemUploadStatus = vi.fn((side, itemId, status) => {
  const it = check?.sides?.[side]?.items.find((i) => i.id === itemId);
  if (it) it.upload = { ...(it.upload || {}), status };
});

vi.mock("./api.js", () => ({
  presignArtifact,
  putMedia,
  dataUrlToBlob,
  contentTypeFromDataUrl,
  ApiError,
}));
vi.mock("./image.js", () => ({ downscaleDataUrl }));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck,
  markItemUploaded,
  setItemUploadStatus,
}));
vi.mock("./instrument.js", () => ({ span: vi.fn(() => vi.fn()) }));

function seedCheck() {
  check = {
    id: "check-1",
    status: "in-progress",
    sideOrder: ["North"],
    sides: {
      North: {
        items: [
          {
            id: "item-1",
            side: "North",
            kind: "photo",
            dataUrl: "data:image/jpeg;base64,FULLRES==",
          },
        ],
      },
    },
  };
}

/** Let queued microtasks drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function importUploader() {
  return import("./artifact-uploader.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  seedCheck();
  presignArtifact.mockResolvedValue({
    artifactId: "art-1",
    s3Key: "checks/site/check-1/art-1.jpg",
    uploadUrl: "https://s3.example/put",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enqueueUpload — happy path", () => {
  it("presigns and PUTs the bytes but never registers", async () => {
    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");
    await flush();

    expect(presignArtifact).toHaveBeenCalledWith("check-1", {
      side: "North",
      contentType: "image/jpeg",
    });
    expect(putMedia).toHaveBeenCalledWith(
      "https://s3.example/put",
      expect.any(Blob),
      "image/jpeg",
    );
    // content type read from full-res BEFORE the thumbnail swap
    expect(contentTypeFromDataUrl).toHaveBeenCalledWith(
      "data:image/jpeg;base64,FULLRES==",
    );
  });

  it("marks the item uploaded and swaps in the thumbnail", async () => {
    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");
    await flush();

    expect(markItemUploaded).toHaveBeenCalledWith("North", "item-1", {
      artifactId: "art-1",
      s3Key: "checks/site/check-1/art-1.jpg",
      contentType: "image/jpeg",
      thumbUrl: "data:image/jpeg;base64,THUMB==",
    });
    expect(check.sides.North.items[0].upload.status).toBe("uploaded");
  });

  it("is a no-op for an item already uploaded", async () => {
    check.sides.North.items[0].upload = { status: "uploaded" };
    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");
    await flush();
    expect(presignArtifact).not.toHaveBeenCalled();
  });

  it("is a no-op when the item was deleted before it ran", async () => {
    check.sides.North.items = [];
    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");
    await flush();
    expect(presignArtifact).not.toHaveBeenCalled();
  });
});

describe("enqueueUpload — failure handling", () => {
  it("retries a network failure, then succeeds", async () => {
    vi.useFakeTimers();
    presignArtifact
      .mockRejectedValueOnce(new ApiError("net", { status: 0 }))
      .mockResolvedValue({
        artifactId: "art-1",
        s3Key: "k",
        uploadUrl: "https://s3.example/put",
      });

    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");

    await vi.advanceTimersByTimeAsync(1000); // first backoff
    await vi.runAllTimersAsync();

    expect(presignArtifact).toHaveBeenCalledTimes(2);
    expect(markItemUploaded).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx and marks the item failed", async () => {
    presignArtifact.mockRejectedValue(new ApiError("too big", { status: 413 }));
    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");
    await flush();

    expect(presignArtifact).toHaveBeenCalledTimes(1);
    expect(setItemUploadStatus).toHaveBeenLastCalledWith(
      "North",
      "item-1",
      "failed",
    );
    expect(markItemUploaded).not.toHaveBeenCalled();
  });

  it("gives up after the attempt cap on persistent 5xx", async () => {
    vi.useFakeTimers();
    presignArtifact.mockRejectedValue(new ApiError("server", { status: 500 }));
    const { enqueueUpload } = await importUploader();
    enqueueUpload("check-1", "North", "item-1");

    await vi.runAllTimersAsync();

    expect(presignArtifact).toHaveBeenCalledTimes(3);
    expect(setItemUploadStatus).toHaveBeenLastCalledWith(
      "North",
      "item-1",
      "failed",
    );
  });
});

describe("concurrency cap", () => {
  it("runs at most 2 uploads at once", async () => {
    let active = 0;
    let peak = 0;
    /** @type {Array<() => void>} */
    const releases = [];
    presignArtifact.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve({
              artifactId: "art",
              s3Key: "k",
              uploadUrl: "https://s3.example/put",
            });
          });
        }),
    );

    check.sides.North.items = [1, 2, 3, 4].map((n) => ({
      id: `item-${n}`,
      side: "North",
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,X==",
    }));

    const { enqueueUpload } = await importUploader();
    for (const it of check.sides.North.items) {
      enqueueUpload("check-1", "North", it.id);
    }
    await flush();

    expect(peak).toBe(2);
    // Drain them all.
    while (releases.length) {
      releases.shift()();
      await flush();
    }
  });
});

describe("resumePendingUploads", () => {
  it("re-enqueues photos that are not yet uploaded", async () => {
    check.sides.North.items = [
      {
        id: "done",
        side: "North",
        kind: "photo",
        dataUrl: "t",
        upload: { status: "uploaded" },
      },
      { id: "pending", side: "North", kind: "photo", dataUrl: "data:,x" },
    ];
    const { resumePendingUploads } = await importUploader();
    resumePendingUploads();
    await flush();

    expect(presignArtifact).toHaveBeenCalledTimes(1);
    expect(markItemUploaded).toHaveBeenCalledWith(
      "North",
      "pending",
      expect.any(Object),
    );
  });

  it("does nothing when there is no in-progress check", async () => {
    check.status = "submitted";
    const { resumePendingUploads } = await importUploader();
    resumePendingUploads();
    await flush();
    expect(presignArtifact).not.toHaveBeenCalled();
  });
});
