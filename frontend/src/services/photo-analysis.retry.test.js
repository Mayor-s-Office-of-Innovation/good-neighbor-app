import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  createCheck: vi.fn(),
  evaluateAssessment: vi.fn(),
  getAssessmentGuidance: vi.fn(),
  getCheck: vi.fn(),
  registerArtifact: vi.fn(),
  submitConditionAnswers: vi.fn(),
  uploadArtifact: vi.fn(),
  registerTextArtifact: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(message, opts = {}) {
      super(message);
      this.status = opts.status;
      this.body = opts.body;
    }
  },
  LEG: { PRESIGN: "presign", PUT: "put", REGISTER: "register" },
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: vi.fn(),
  updateItem: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));

import {
  getCheck,
  registerArtifact,
  registerTextArtifact,
  uploadArtifact,
  ApiError,
} from "./api.js";
import {
  getCurrentCheck,
  updateItem,
  updateItemAnalysis,
} from "../state/check-session.js";
import { retryEvidenceItem } from "./photo-analysis.js";

beforeEach(() => vi.resetAllMocks());

// Unique item id per test: photo-analysis dedupes concurrent runs on the item
// id, and a previous test's still-pending poll would swallow the next test's
// run otherwise.
let testSeq = 0;

function sessionItem(overrides = {}) {
  return {
    id: `item-${++testSeq}`,
    kind: "photo",
    uploadedAt: "2026-09-15T10:00:00Z",
    analysis: { status: "failed" },
    upload: { status: "failed" },
    ...overrides,
  };
}

// Loose fixtures — the mocked module surface is intentionally partial.
/** @returns {any} */
function session(checkItem) {
  return { id: "check", items: [checkItem] };
}

describe("retryEvidenceItem", () => {
  it("resumes polling directly when the artifact was already registered", async () => {
    const item = sessionItem({
      upload: { status: "uploaded", artifactId: "artifact-1" },
      analysis: { status: "failed", artifactId: "artifact-1" },
    });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({ analyses: [], artifacts: [] }),
    );

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      // The poll looks at the backend before its first sleep.
      expect(getCheck).toHaveBeenCalledWith("check");
    });

    // Straight back to polling; no re-upload.
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        status: "analyzing",
        error: undefined,
        failure: undefined,
      }),
    );
    expect(updateItem).not.toHaveBeenCalled();
    expect(uploadArtifact).not.toHaveBeenCalled();
  });

  it("replays the whole pipeline for a failed upload", async () => {
    const item = sessionItem();
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({ analyses: [], artifacts: [] }),
    );
    vi.mocked(uploadArtifact).mockResolvedValue(
      /** @type {any} */ ({ artifactId: "artifact-2", s3Key: "checks/s/c/b" }),
    );

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(uploadArtifact).toHaveBeenCalled();
    });

    expect(updateItem).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        upload: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ status: "queued" }),
    );
  });

  it("re-registers text evidence on retry", async () => {
    const item = sessionItem({ kind: "text", text: "Litter by the door" });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({ analyses: [], artifacts: [] }),
    );
    vi.mocked(registerTextArtifact).mockResolvedValue("artifact-3");

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(registerTextArtifact).toHaveBeenCalled();
    });
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ status: "queued" }),
    );
  });

  it("ignores unknown items", () => {
    vi.mocked(getCurrentCheck).mockReturnValue(session(sessionItem()));
    retryEvidenceItem("ghost");
    expect(updateItemAnalysis).not.toHaveBeenCalled();
    expect(getCheck).not.toHaveBeenCalled();
  });

  it("records upload failures with the leg, what succeeded, and the wait", async () => {
    const item = sessionItem();
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({ analyses: [], artifacts: [] }),
    );
    const boom = Object.assign(
      new ApiError("Network error uploading media: offline", { status: 0 }),
      { leg: "upload" },
    );
    vi.mocked(uploadArtifact).mockRejectedValue(boom);

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(updateItemAnalysis).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({
          status: "failed",
          error: "Could not analyze this item.",
          failure: expect.objectContaining({
            leg: "upload",
            uploaded: false,
            enqueued: false,
            waitedMs: expect.any(Number),
          }),
        }),
      );
    });
  });

  it("records analyzer timeouts with uploaded/enqueued true and the waited time", async () => {
    vi.useFakeTimers();
    try {
      const item = sessionItem({
        upload: { status: "uploaded", artifactId: "artifact-1" },
        analysis: { status: "failed", artifactId: "artifact-1" },
      });
      vi.mocked(getCurrentCheck).mockReturnValue(session(item));
      vi.mocked(getCheck).mockResolvedValue(
        /** @type {any} */ ({ analyses: [], artifacts: [] }),
      );

      retryEvidenceItem(item.id);
      // Drain the poll loop through its 180s deadline; the thrown
      // analyses_pending lands in run()'s failure record.
      await vi.runAllTimersAsync();

      const failureCall = vi
        .mocked(updateItemAnalysis)
        .mock.calls.find(([, patch]) => patch?.failure?.leg === "analyze");
      expect(failureCall).toBeTruthy();
      const [, patch] = failureCall;
      expect(patch).toEqual(
        expect.objectContaining({
          status: "failed",
          error: "Analysis is taking longer than expected.",
          failure: expect.objectContaining({
            leg: "analyze",
            uploaded: true,
            enqueued: true,
            waitedMs: expect.any(Number),
          }),
        }),
      );
      // The 180s poll ceiling is what we waited.
      expect(patch.failure.waitedMs).toBeGreaterThanOrEqual(180000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-enqueues via registerArtifact for an analyze-leg failure (no re-upload)", async () => {
    const item = sessionItem({
      upload: {
        status: "uploaded",
        artifactId: "artifact-1",
        s3Key: "checks/s/c/a",
      },
      analysis: {
        status: "failed",
        artifactId: "artifact-1",
        s3Key: "checks/s/c/a",
        failure: { leg: "analyze", uploaded: true, enqueued: true },
      },
    });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(registerArtifact).mockResolvedValue(
      /** @type {any} */ ({ artifactId: "artifact-1", status: "queued" }),
    );

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(registerArtifact).toHaveBeenCalledWith(
        "check",
        expect.objectContaining({
          artifactId: "artifact-1",
          s3Key: "checks/s/c/a",
        }),
      );
    });
    // Same artifact re-driven: no new upload, no new artifact id.
    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ status: "analyzing", failure: undefined }),
    );
  });

  it("seeds upload-only artifact coordinates and re-enqueues on retry", async () => {
    const item = sessionItem({
      upload: {
        status: "uploaded",
        artifactId: "artifact-1",
        s3Key: "checks/s/c/a",
      },
      analysis: {
        status: "failed",
        failure: { leg: "analyze", uploaded: true, enqueued: true },
      },
    });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(registerArtifact).mockResolvedValue(
      /** @type {any} */ ({ artifactId: "artifact-1", status: "queued" }),
    );

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(registerArtifact).toHaveBeenCalledWith(
        "check",
        expect.objectContaining({ artifactId: "artifact-1" }),
      );
    });
    // upload.artifactId is adopted into analysis so run()/poll can see it.
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ artifactId: "artifact-1" }),
    );
  });

  it("records a re-register failure back onto the failed card", async () => {
    const item = sessionItem({
      upload: { status: "uploaded", artifactId: "artifact-1" },
      analysis: {
        status: "failed",
        artifactId: "artifact-1",
        failure: { leg: "analyze", uploaded: true, enqueued: true },
      },
    });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(registerArtifact).mockRejectedValue(
      new ApiError("Network error calling POST /v1/checks/check/artifacts", {
        status: 0,
      }),
    );

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(updateItemAnalysis).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({
          status: "failed",
          failure: expect.objectContaining({
            leg: "start",
            uploaded: true,
            enqueued: false,
          }),
        }),
      );
    });
  });

  it("replays the pipeline when the failure is the upload leg itself", async () => {
    const item = sessionItem({
      upload: { status: "failed" },
      analysis: {
        status: "failed",
        failure: { leg: "upload", uploaded: false, enqueued: false },
      },
    });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({ analyses: [], artifacts: [] }),
    );
    vi.mocked(uploadArtifact).mockResolvedValue(
      /** @type {any} */ ({ artifactId: "artifact-5", s3Key: "checks/s/c/e" }),
    );

    retryEvidenceItem(item.id);
    await vi.waitFor(() => {
      expect(uploadArtifact).toHaveBeenCalled();
    });
    expect(registerArtifact).not.toHaveBeenCalled();
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ status: "queued" }),
    );
  });
});
