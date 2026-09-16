import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  createCheck: vi.fn(),
  evaluateAssessment: vi.fn(),
  getAssessmentGuidance: vi.fn(),
  getCheck: vi.fn(),
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

// Unique item id per test: photo-analysis dedupes concurrent runs on
// `${placeId}:${itemId}`, and a previous test's still-pending poll would
// swallow the next test's run otherwise.
let testSeq = 0;

function sessionItem(overrides = {}) {
  return {
    id: `item-${++testSeq}`,
    kind: "photo",
    placeName: "Sidewalk",
    uploadedAt: "2026-09-15T10:00:00Z",
    analysis: { status: "failed" },
    upload: { status: "failed" },
    ...overrides,
  };
}

// Loose fixtures — the mocked module surface is intentionally partial.
/** @returns {any} */
function session(checkItem) {
  return {
    id: "check",
    placeOrder: ["sidewalk"],
    places: {
      sidewalk: { id: "sidewalk", name: "Sidewalk", items: [checkItem] },
    },
  };
}

describe("retryEvidenceItem", () => {
  it("resumes polling directly when the artifact was already registered", async () => {
    const item = sessionItem({
      upload: { status: "uploaded", artifactId: "artifact-1" },
      analysis: { status: "failed", artifactId: "artifact-1" },
    });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ ({ analyses: [], artifacts: [] }));

    retryEvidenceItem("sidewalk", item.id);
    await vi.waitFor(() => {
      // The poll looks at the backend before its first sleep.
      expect(getCheck).toHaveBeenCalledWith("check");
    });

    // Straight back to polling; no re-upload.
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      "sidewalk",
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
    vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ ({ analyses: [], artifacts: [] }));
    vi.mocked(uploadArtifact).mockResolvedValue("artifact-2");

    retryEvidenceItem("sidewalk", item.id);
    await vi.waitFor(() => {
      expect(uploadArtifact).toHaveBeenCalled();
    });

    expect(updateItem).toHaveBeenCalledWith(
      "sidewalk",
      item.id,
      expect.objectContaining({
        upload: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      "sidewalk",
      item.id,
      expect.objectContaining({ status: "queued" }),
    );
  });

  it("re-registers text evidence on retry", async () => {
    const item = sessionItem({ kind: "text", text: "Litter by the door" });
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ ({ analyses: [], artifacts: [] }));
    vi.mocked(registerTextArtifact).mockResolvedValue("artifact-3");

    retryEvidenceItem("sidewalk", item.id);
    await vi.waitFor(() => {
      expect(registerTextArtifact).toHaveBeenCalled();
    });
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      "sidewalk",
      item.id,
      expect.objectContaining({ status: "queued" }),
    );
  });

  it("ignores unknown items", () => {
    vi.mocked(getCurrentCheck).mockReturnValue(session(sessionItem()));
    retryEvidenceItem("sidewalk", "ghost");
    expect(updateItemAnalysis).not.toHaveBeenCalled();
    expect(getCheck).not.toHaveBeenCalled();
  });

  it("records upload failures with the leg, what succeeded, and the wait", async () => {
    const item = sessionItem();
    vi.mocked(getCurrentCheck).mockReturnValue(session(item));
    vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ ({ analyses: [], artifacts: [] }));
    const boom = Object.assign(
      new ApiError("Network error uploading media: offline", { status: 0 }),
      { leg: "upload" },
    );
    vi.mocked(uploadArtifact).mockRejectedValue(boom);

    retryEvidenceItem("sidewalk", item.id);
    await vi.waitFor(() => {
      expect(updateItemAnalysis).toHaveBeenCalledWith(
        "sidewalk",
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
      vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ ({ analyses: [], artifacts: [] }));

      retryEvidenceItem("sidewalk", item.id);
      // Drain the poll loop through its 180s deadline; the thrown
      // analyses_pending lands in run()'s failure record.
      await vi.runAllTimersAsync();

      const failureCall = vi
        .mocked(updateItemAnalysis)
        .mock.calls.find(([, , patch]) => patch?.failure?.leg === "analyze");
      expect(failureCall).toBeTruthy();
      const [, , patch] = failureCall;
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
});