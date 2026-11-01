import { afterEach, beforeEach, expect, it, vi } from "vitest";
const held = vi.hoisted(() => ({ check: null, saved: [] }));
vi.mock("../db.js", () => ({
  saveDraft: vi.fn(async (check) => {
    held.saved.push(structuredClone(check));
  }),
  saveFinishedCheck: vi.fn(async () => {}),
  getSite: vi.fn(async () => ({ siteId: "site" })),
  getCaptureMedia: vi.fn(),
  releaseCaptureOriginal: vi.fn(async () => {}),
  deleteCapturePhoto: vi.fn(async () => {}),
}));
vi.mock("./backend-health.js", () => ({ getHealthState: () => "healthy" }));
vi.mock("./device-location.js", () => ({
  readCaptureDeviceLocation: () => ({
    atUpload: () => null,
    later: Promise.resolve(null),
  }),
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => held.check,
  removeItem: vi.fn((id) => {
    held.check.items = held.check.items.filter((item) => item.id !== id);
  }),
  getCheck: () => held.check,
  findCheckForItem: () => held.check,
  updateItem: (id, patch) =>
    Object.assign(
      held.check.items.find((item) => item.id === id),
      patch,
    ),
  updateItemAnalysis: (id, patch) => {
    const item = held.check.items.find((item) => item.id === id);
    item.analysis = { ...item.analysis, ...patch };
  },
}));
vi.mock("./api.js", () => ({
  createCheck: vi.fn(async () => {}),
  deleteArtifact: vi.fn(async () => ({})),
  getCheck: vi.fn(),
  evaluateAssessment: vi.fn(async () => ({
    assessment: {},
    tasks: [],
    conditions: [],
  })),
  registerArtifact: vi.fn(async () => ({})),
  uploadArtifact: vi.fn(),
  registerTextArtifact: vi.fn(async () => "text-artifact"),
  contentTypeFromDataUrl: () => "image/jpeg",
  dataUrlToBlob: async () => new Blob(["synthetic"]),
  LEG: { PUT: "put" },
  ApiError: class extends Error {
    constructor(message, options = {}) {
      super(message);
      Object.assign(this, options);
    }
  },
}));
import {
  getCheck,
  deleteArtifact,
  registerArtifact,
  uploadArtifact,
  evaluateAssessment,
} from "./api.js";
import {
  saveDraft,
  getCaptureMedia,
  releaseCaptureOriginal,
  deleteCapturePhoto,
} from "../db.js";
import {
  analyzeEvidenceItem,
  retryEvidenceItem,
  reconcileFailedEvidence,
  removeEvidenceItem,
  shouldResumeEvidenceItem,
} from "./photo-analysis.js";
import { cancelCheckPolling } from "./check-polling.js";

let sequence = 0;
function photo(extra = {}) {
  const item = {
    id: `item-${++sequence}`,
    deletionPending: /** @type {boolean | undefined} */ (undefined),
    kind: "photo",
    dataUrl: "data:image/jpeg;base64,AA",
    analysis: { status: "idle" },
    ...extra,
  };
  held.check = {
    id: "check",
    siteId: "site",
    status: "in-progress",
    remoteStarted: true,
    items: [item],
  };
  return item;
}
const successful = { artifactId: "artifact", status: "analyzed", concerns: [] };
beforeEach(() => {
  vi.clearAllMocks();
  held.saved = [];
  vi.mocked(saveDraft)
    .mockReset()
    .mockImplementation(async (check) => {
      held.saved.push(structuredClone(check));
    });
  vi.mocked(deleteCapturePhoto).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { onLine: true });
  vi.mocked(uploadArtifact).mockReset().mockResolvedValue({
    artifactId: "artifact",
    s3Key: "synthetic-key",
    contentType: "image/jpeg",
    contentLength: 9,
  });
  vi.mocked(getCheck)
    .mockReset()
    .mockResolvedValue({ check: {}, analyses: [successful], artifacts: [] });
  vi.mocked(evaluateAssessment)
    .mockReset()
    .mockResolvedValue({ assessment: {}, conditions: [], tasks: [] });
  vi.mocked(registerArtifact)
    .mockReset()
    .mockResolvedValue({ artifactId: "artifact", status: "queued" });
});
afterEach(async () => {
  cancelCheckPolling("check");
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});

it("persists evidence before uploading and completes without a tap", async () => {
  const item = photo();
  vi.mocked(uploadArtifact).mockImplementationOnce(async () => {
    expect(held.saved[0].items[0].dataUrl).toBe(item.dataUrl);
    return {
      artifactId: "artifact",
      s3Key: "synthetic-key",
      contentType: "image/jpeg",
      contentLength: 9,
    };
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(item.analysis.recovery).toBeUndefined();
});
it("automatically retries a server upload failure within the budget", async () => {
  const item = photo();
  vi.mocked(uploadArtifact).mockRejectedValueOnce(
    Object.assign(new Error("unavailable"), { status: 503 }),
  );
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() =>
    expect(item.analysis.recovery?.state).toBe("scheduled"),
  );
  expect(retryEvidenceItem(item.id)).toBeUndefined();
  expect(shouldResumeEvidenceItem(item)).toBe(false);
  item.analysis.recovery.nextAttemptAt = Date.now() - 1;
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(uploadArtifact).toHaveBeenCalledTimes(2);
});
it("exhausts automatic retries, then accepts only one manual cycle", async () => {
  const item = photo({
    analysis: {
      status: "queued",
      recovery: { stage: "upload", attempts: 3, state: "scheduled" },
    },
  });
  vi.mocked(uploadArtifact).mockRejectedValueOnce(
    Object.assign(new Error("unavailable"), { status: 503 }),
  );
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.recovery?.state).toBe("manual"));
  expect(shouldResumeEvidenceItem(item)).toBe(false);
  expect(retryEvidenceItem(item.id)).toBe(true);
  expect(retryEvidenceItem(item.id)).toBeUndefined();
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(uploadArtifact).toHaveBeenCalledTimes(2);
});
it("pauses a network interruption without consuming the budget and resumes", async () => {
  const item = photo();
  vi.mocked(uploadArtifact).mockRejectedValueOnce(
    Object.assign(new Error("offline"), { status: 0 }),
  );
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("waiting"));
  expect(item.analysis.recovery.attempts || 0).toBe(0);
  vi.stubGlobal("navigator", { onLine: false });
  expect(retryEvidenceItem(item.id)).toBeUndefined();
  vi.stubGlobal("navigator", { onLine: true });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
});
it("does not reset an exhausted budget on reconnection", () => {
  const item = photo({
    analysis: {
      status: "failed",
      recovery: { stage: "upload", attempts: 3, state: "manual" },
    },
  });
  vi.stubGlobal("navigator", { onLine: false });
  expect(retryEvidenceItem(item.id)).toBeUndefined();
  vi.stubGlobal("navigator", { onLine: true });
  expect(shouldResumeEvidenceItem(item)).toBe(false);
  expect(item.analysis.recovery.attempts).toBe(3);
});
it("keeps registration checkpoints when another upload attempt begins", async () => {
  const upload = {
    status: "uploading",
    artifactId: "artifact",
    s3Key: "synthetic-key",
    bytesUploaded: true,
  };
  const item = photo({ upload });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(uploadArtifact).toHaveBeenCalled());
  expect(vi.mocked(uploadArtifact).mock.calls[0][1].checkpoint).toMatchObject({
    bytesUploaded: true,
    artifactId: "artifact",
  });
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
});
it("retries guidance without uploading or restarting analysis", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: {
      status: "queued",
      sourceAnalysis: successful,
      recovery: { stage: "evaluate", state: "scheduled", attempts: 1 },
    },
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(getCheck).not.toHaveBeenCalled();
  expect(registerArtifact).not.toHaveBeenCalled();
  expect(uploadArtifact).not.toHaveBeenCalled();
});
it("exposes server exhaustion and restarts it once with a persisted identity", async () => {
  const item = photo({
    upload: {
      status: "uploaded",
      artifactId: "artifact",
      contentType: "image/jpeg",
      contentLength: 9,
    },
  });
  vi.mocked(getCheck).mockResolvedValueOnce({
    check: {},
    artifacts: [],
    analyses: [
      {
        artifactId: "artifact",
        status: "failed",
        retryable: true,
        analysisGeneration: "generation-1",
      },
    ],
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.recovery?.state).toBe("manual"));
  retryEvidenceItem(item.id);
  retryEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(registerArtifact).toHaveBeenCalledTimes(1);
  const request = vi.mocked(registerArtifact).mock.calls[0][1];
  expect(request.expectedGeneration).toBe("generation-1");
  expect(
    held.saved.some(
      (check) =>
        check.items[0].analysis.restartRequestId === request.retryRequestId,
    ),
  ).toBe(true);
  expect(uploadArtifact).not.toHaveBeenCalled();
});
it("does not offer another attempt for permanent server failure", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
  });
  vi.mocked(getCheck).mockResolvedValueOnce({
    check: {},
    artifacts: [],
    analyses: [{ artifactId: "artifact", status: "failed", retryable: false }],
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.recovery?.state).toBe("blocked"));
  expect(retryEvidenceItem(item.id)).toBeUndefined();
});
it("does not upload when local saving fails", async () => {
  const item = photo();
  vi.mocked(saveDraft).mockRejectedValueOnce(new Error("storage full"));
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.recovery?.stage).toBe("storage"));
  expect(item.analysis.localSaveConfirmed).toBe(false);
  expect(uploadArtifact).not.toHaveBeenCalled();
});
it("leaves an old uploaded artifact in observation rather than blindly re-enqueueing", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: { status: "failed", failure: { leg: "analyze" } },
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(registerArtifact).not.toHaveBeenCalled();
  expect(uploadArtifact).not.toHaveBeenCalled();
});

it("reconciles late server success without restarting analysis or uploading", async () => {
  const item = photo({
    analysis: {
      status: "failed",
      artifactId: "artifact",
      failure: { leg: "analyze" },
      serverGeneration: "old",
      recovery: { state: "manual", stage: "analyze" },
    },
  });
  await reconcileFailedEvidence(held.check);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(uploadArtifact).not.toHaveBeenCalled();
  expect(registerArtifact).not.toHaveBeenCalled();
});
it("does not replace an exhausted result with success from an older generation", async () => {
  const item = photo({
    analysis: {
      status: "failed",
      artifactId: "artifact",
      failure: { leg: "analyze" },
      recovery: { state: "manual", stage: "analyze" },
    },
  });
  vi.mocked(getCheck).mockResolvedValue({
    check: {},
    artifacts: [{ artifactId: "artifact", analysisGeneration: "new" }],
    analyses: [{ ...successful, analysisGeneration: "old" }],
  });
  await reconcileFailedEvidence(held.check);
  expect(item.analysis.recovery.state).toBe("manual");
  expect(registerArtifact).not.toHaveBeenCalled();
});

it("keeps failed evidence when deletion fails and removes it after a successful retry", async () => {
  const item = photo({
    analysis: {
      status: "failed",
      artifactId: "artifact",
      recovery: { state: "blocked" },
    },
  });
  vi.mocked(deleteArtifact).mockRejectedValueOnce(
    Object.assign(new Error("offline"), { status: 0 }),
  );
  await expect(removeEvidenceItem(item.id)).rejects.toThrow("offline");
  expect(held.check.items).toContain(item);
  await removeEvidenceItem(item.id);
  expect(held.check.items).toHaveLength(0);
});

it("removes local-only failed evidence offline without a server request", async () => {
  const item = photo({ analysis: { status: "failed" } });
  vi.stubGlobal("navigator", { onLine: false });
  await removeEvidenceItem(item.id);
  expect(held.check.items).toHaveLength(0);
  expect(deleteArtifact).not.toHaveBeenCalled();
});
it("keeps uploaded evidence offline and deduplicates deletion once connected", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: { status: "failed", failure: { uploaded: false } },
  });
  vi.stubGlobal("navigator", { onLine: false });
  await expect(removeEvidenceItem(item.id)).rejects.toThrow();
  expect(held.check.items).toContain(item);
  expect(deleteArtifact).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", { onLine: true });
  /** @type {(value: any) => void} */
  let complete = () => {
    throw new Error("Deletion has not started");
  };
  vi.mocked(deleteArtifact).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = removeEvidenceItem(item.id);
  const again = removeEvidenceItem(item.id);
  expect(again).toBe(pending);
  await vi.waitFor(() => expect(deleteArtifact).toHaveBeenCalledOnce());
  complete({});
  await pending;
  expect(held.check.items).toHaveLength(0);
});
it("restores the failed card when its removal cannot be saved", async () => {
  const item = photo({ analysis: { status: "failed" } });
  vi.mocked(saveDraft).mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(removeEvidenceItem(item.id)).rejects.toThrow(
    "Could not save evidence removal",
  );
  expect(held.check.items).toContain(item);
});

it("saves deletion intent before deleting and replays it after local removal fails", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: {
      status: "failed",
      artifactId: "artifact",
      recovery: { state: "blocked" },
    },
  });
  vi.mocked(saveDraft)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("storage unavailable"));
  vi.mocked(deleteArtifact).mockImplementationOnce(async () => {
    expect(item.deletionPending).toBe(true);
    expect(saveDraft).toHaveBeenCalled();
    return { artifactId: "artifact", status: "deleted" };
  });
  await expect(removeEvidenceItem(item.id)).rejects.toThrow(
    "Could not save evidence removal",
  );
  expect(held.check.items).toContain(item);
  expect(item.deletionPending).toBe(true);
  expect(shouldResumeEvidenceItem(item)).toBe(false);
  vi.mocked(deleteArtifact).mockRejectedValueOnce(
    Object.assign(new Error("already deleted"), { status: 404 }),
  );
  await removeEvidenceItem(item.id);
  expect(held.check.items).toHaveLength(0);
  expect(deleteArtifact).toHaveBeenCalledTimes(2);
});
it("never deletes remotely when its intent cannot be saved", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: { status: "failed" },
  });
  vi.mocked(saveDraft).mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(removeEvidenceItem(item.id)).rejects.toThrow();
  expect(deleteArtifact).not.toHaveBeenCalled();
  expect(item.deletionPending).toBeUndefined();
});

it.each([400, 401, 403, 409, 410, 422])(
  "clears a definitively rejected deletion (%s) durably and retains the card",
  async (status) => {
    const item = photo({
      upload: { status: "uploaded", artifactId: "artifact" },
      analysis: {
        status: "failed",
        artifactId: "artifact",
        recovery: { state: "blocked" },
      },
    });
    vi.mocked(deleteArtifact).mockRejectedValueOnce(
      Object.assign(new Error("rejected"), { status }),
    );
    await expect(removeEvidenceItem(item.id)).rejects.toThrow("rejected");
    expect(item.deletionPending).toBe(false);
    expect(held.check.items).toContain(item);
    expect(held.saved.at(-1).items[0].deletionPending).toBe(false);
  },
);
it.each([0, 408, 429, 503])(
  "preserves deletion intent for an unresolved response (%s)",
  async (status) => {
    const item = photo({
      upload: { status: "uploaded", artifactId: "artifact" },
    });
    vi.mocked(deleteArtifact).mockRejectedValueOnce(
      Object.assign(new Error("uncertain"), { status }),
    );
    await expect(removeEvidenceItem(item.id)).rejects.toThrow("uncertain");
    expect(item.deletionPending).toBe(true);
  },
);
it.each([false, true])(
  "retries pending server cleanup without inferring success from artifact absence (replay=%s)",
  async (wasPending) => {
    const item = photo({
      deletionPending: wasPending,
      upload: { status: "uploaded", artifactId: "artifact" },
    });
    vi.mocked(getCheck).mockResolvedValueOnce({
      check: {},
      analyses: [],
      artifacts: [],
    });
    const pendingError = Object.assign(new Error("cleanup pending"), {
      status: 409,
      body: { code: "EvidenceDeletionPending" },
    });
    vi.mocked(deleteArtifact)
      .mockRejectedValueOnce(pendingError)
      .mockRejectedValueOnce(pendingError)
      .mockResolvedValueOnce({ artifactId: "artifact", status: "deleted" });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(removeEvidenceItem(item.id)).rejects.toBe(pendingError);
      expect(item.deletionPending).toBe(true);
      expect(held.saved.at(-1).items[0].deletionPending).toBe(true);
      expect(held.check.items).toContain(item);
      expect(getCheck).not.toHaveBeenCalled();
      expect(deleteCapturePhoto).not.toHaveBeenCalled();
    }
    await removeEvidenceItem(item.id);
    expect(deleteArtifact).toHaveBeenCalledTimes(3);
    expect(held.check.items).toHaveLength(0);
    expect(held.saved.at(-1).items).toHaveLength(0);
  },
);

it("keeps deletion pending when its definitive rejection cannot be persisted", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
  });
  vi.mocked(saveDraft)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("storage unavailable"));
  vi.mocked(deleteArtifact).mockRejectedValueOnce(
    Object.assign(new Error("rejected"), { status: 409 }),
  );
  await expect(removeEvidenceItem(item.id)).rejects.toThrow(
    "Could not save evidence removal",
  );
  expect(item.deletionPending).toBe(true);
});
it.each([false, true])(
  "reconciles a rejected replay against server evidence, exists=%s",
  async (exists) => {
    const item = photo({
      deletionPending: true,
      upload: { status: "uploaded", artifactId: "artifact" },
    });
    vi.mocked(getCheck).mockResolvedValueOnce({
      check: {},
      analyses: [],
      artifacts: exists ? [{ artifactId: "artifact" }] : [],
    });
    vi.mocked(deleteArtifact).mockRejectedValueOnce(
      Object.assign(new Error("rejected"), { status: 409 }),
    );
    const pending = removeEvidenceItem(item.id);
    if (exists) {
      await expect(pending).rejects.toThrow("rejected");
      expect(item.deletionPending).toBe(false);
      expect(held.check.items).toContain(item);
    } else {
      await pending;
      expect(held.check.items).toHaveLength(0);
    }
  },
);
it("retains unresolved deletion when the server cannot confirm whether its replay already succeeded", async () => {
  const item = photo({
    deletionPending: true,
    upload: { status: "uploaded", artifactId: "artifact" },
  });
  vi.mocked(getCheck).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(deleteArtifact).mockRejectedValueOnce(
    Object.assign(new Error("rejected"), { status: 409 }),
  );
  await expect(removeEvidenceItem(item.id)).rejects.toThrow();
  expect(item.deletionPending).toBe(true);
  expect(held.check.items).toContain(item);
});

it.each([false, true])(
  "retains Blob originals until registration is durable (save fails=%s)",
  async (saveFails) => {
    const original = new Blob(["original"], { type: "image/jpeg" });
    vi.mocked(getCaptureMedia).mockResolvedValueOnce({ original });
    const item = photo({
      dataUrl: undefined,
      media: { key: "synthetic", size: original.size, type: original.type },
    });
    vi.mocked(uploadArtifact).mockImplementationOnce(
      async (_checkId, options) => {
        expect(options.blob).toBe(original);
        expect(options.originSiteId).toBe("site");
        expect(releaseCaptureOriginal).not.toHaveBeenCalled();
        await options.onCheckpoint({
          artifactId: "artifact",
          s3Key: "synthetic-key",
          bytesUploaded: true,
        });
        if (saveFails)
          vi.mocked(saveDraft).mockRejectedValueOnce(
            new Error("Synthetic storage failure"),
          );
        return {
          artifactId: "artifact",
          s3Key: "synthetic-key",
          contentType: "image/jpeg",
          contentLength: original.size,
        };
      },
    );
    analyzeEvidenceItem(item.id);
    await vi.waitFor(() =>
      expect(item.analysis.status).toBe(saveFails ? "failed" : "analyzed"),
    );
    if (saveFails) expect(releaseCaptureOriginal).not.toHaveBeenCalled();
    else {
      expect(releaseCaptureOriginal).toHaveBeenCalledWith(
        "synthetic",
        "artifact",
      );
      expect(
        held.saved.some(
          (check) => check.items[0].upload?.status === "uploaded",
        ),
      ).toBe(true);
    }
  },
);
it("continues analysis when optional Blob cleanup fails", async () => {
  vi.mocked(getCaptureMedia).mockResolvedValueOnce({
    original: new Blob(["original"]),
  });
  vi.mocked(releaseCaptureOriginal).mockRejectedValueOnce(
    new Error("Synthetic cleanup failure"),
  );
  const item = photo({
    media: { key: "synthetic", size: 8, type: "image/jpeg" },
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
});
it("awaits atomic media removal after durable remote-deletion checkpoint", async () => {
  const item = photo({
    media: { key: "synthetic", size: 8, type: "image/jpeg" },
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: {
      status: "failed",
      recovery: { state: "blocked", stage: "analyze" },
    },
  });
  vi.mocked(deleteCapturePhoto).mockImplementationOnce(async () => {
    expect(held.saved.some((check) => check.items[0]?.deletionPending)).toBe(
      true,
    );
    expect(deleteArtifact).toHaveBeenCalled();
    expect(held.check.items).toContain(item);
  });
  await removeEvidenceItem(item.id);
  expect(deleteCapturePhoto).toHaveBeenCalledWith(held.check, "synthetic");
  expect(held.check.items).toEqual([]);
});

it("does not restore a committed photo removal when a later save would fail", async () => {
  const item = photo({
    media: { key: "synthetic", size: 8, type: "image/jpeg" },
  });
  vi.mocked(saveDraft)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("storage unavailable"));
  await removeEvidenceItem(item.id);
  expect(deleteCapturePhoto).toHaveBeenCalledWith(held.check, "synthetic");
  expect(saveDraft).toHaveBeenCalledTimes(1);
  expect(held.check.items).toEqual([]);
});

it("keeps a retryable photo when atomic local deletion fails after remote deletion", async () => {
  const item = photo({
    media: { key: "synthetic", size: 8, type: "image/jpeg" },
    upload: { status: "uploaded", artifactId: "artifact" },
  });
  vi.mocked(deleteCapturePhoto).mockRejectedValueOnce(
    new Error("storage unavailable"),
  );
  await expect(removeEvidenceItem(item.id)).rejects.toThrow(
    "storage unavailable",
  );
  expect(held.check.items).toContain(item);
  expect(item.deletionPending).toBe(true);
  expect(shouldResumeEvidenceItem(item)).toBe(false);
  vi.mocked(deleteArtifact).mockRejectedValueOnce(
    Object.assign(new Error("already deleted"), { status: 404 }),
  );
  await removeEvidenceItem(item.id);
  expect(held.check.items).toEqual([]);
});

it("bounds pending observation and manually resumes without uploading or restarting", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: {
      status: "analyzing",
      artifactId: "artifact",
      serverGeneration: "generation",
    },
  });
  vi.mocked(getCheck).mockRejectedValue(
    Object.assign(new Error("pending"), { body: { code: "analyses_pending" } }),
  );
  for (let cycle = 0; cycle < 4; cycle++) {
    expect(analyzeEvidenceItem(item.id)).toBe(true);
    await vi.waitFor(() =>
      expect(item.analysis.recovery?.state).toBe(
        cycle === 3 ? "manual" : "scheduled",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cycle < 3) item.analysis.recovery.nextAttemptAt = Date.now() - 1;
  }
  expect(item.analysis.status).toBe("failed");
  expect(held.saved.at(-1).items[0].analysis.recovery).toMatchObject({
    stage: "observe",
    state: "manual",
    attempts: 3,
  });
  expect(shouldResumeEvidenceItem(item)).toBe(false);
  vi.mocked(getCheck).mockResolvedValue({
    check: {},
    analyses: [successful],
    artifacts: [],
  });
  expect(retryEvidenceItem(item.id)).toBe(true);
  expect(retryEvidenceItem(item.id)).toBeUndefined();
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(uploadArtifact).not.toHaveBeenCalled();
  expect(registerArtifact).not.toHaveBeenCalled();
});

it("does not charge pending observation against its budget after losing connection", async () => {
  const item = photo({
    upload: { status: "uploaded", artifactId: "artifact" },
    analysis: {
      status: "analyzing",
      artifactId: "artifact",
      recovery: { stage: "observe", state: "scheduled", attempts: 2 },
    },
  });
  vi.mocked(getCheck).mockImplementation(async () => {
    vi.stubGlobal("navigator", { onLine: false });
    throw Object.assign(new Error("pending"), {
      body: { code: "analyses_pending" },
    });
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("waiting"));
  expect(item.analysis.recovery).toMatchObject({
    stage: "observe",
    state: "waiting",
    attempts: 2,
  });
});

it("repairs restored analyzed evidence once and does not reuse unregistered cached analysis", async () => {
  const item = photo({
    analysis: {
      status: "analyzed",
      sourceAnalysis: { artifactId: "old", status: "analyzed", concerns: [] },
    },
  });
  expect(analyzeEvidenceItem(item.id)).toBe(true);
  expect(analyzeEvidenceItem(item.id)).toBeUndefined();
  await vi.waitFor(() => expect(item.analysis.artifactId).toBe("artifact"));
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(item.analysis.repairingRegistration).toBeUndefined();
  expect(item.analysis.sourceAnalysis.artifactId).toBe("artifact");
  expect(uploadArtifact).toHaveBeenCalledTimes(1);
});

it("adopts a registered saved identity without uploading restored evidence again", async () => {
  const item = photo({
    upload: { status: "uploading", artifactId: "artifact" },
    analysis: { status: "analyzed" },
  });
  vi.mocked(getCheck).mockResolvedValue({
    check: {},
    artifacts: [{ artifactId: "artifact" }],
    analyses: [successful],
  });
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.artifactId).toBe("artifact"));
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(uploadArtifact).not.toHaveBeenCalled();
});

it("retains registration repair identity through an interrupted analysis retry", async () => {
  const item = photo({
    analysis: {
      status: "analyzed",
      sourceAnalysis: { artifactId: "old", status: "analyzed", concerns: [] },
    },
  });
  vi.mocked(getCheck)
    .mockResolvedValueOnce({ check: {}, artifacts: [], analyses: [] })
    .mockRejectedValueOnce(
      Object.assign(new Error("temporary"), { status: 503 }),
    );
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() =>
    expect(item.analysis.recovery?.state).toBe("scheduled"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(item.analysis.repairingRegistration).toBe(true);
  item.analysis.recovery.nextAttemptAt = Date.now() - 1;
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(item.analysis.status).toBe("analyzed"));
  expect(item.analysis.sourceAnalysis.artifactId).toBe("artifact");
  expect(uploadArtifact).toHaveBeenCalledTimes(1);
});
