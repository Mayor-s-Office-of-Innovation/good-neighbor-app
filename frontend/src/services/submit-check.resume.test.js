import { beforeEach, describe, expect, it, vi } from "vitest";

class ApiError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.status = status;
  }
}
const createCheck = vi.fn(async () => ({ checkId: "check-1" }));
const uploadArtifact = vi.fn(async () => "artifact-uploaded");
const registerArtifact = vi.fn(async () => ({
  artifactId: "artifact-eager",
  status: "registered",
}));
const registerTextArtifact = vi.fn(async () => "artifact-text");
const waitForAnalyses = vi.fn(async () => ({
  artifacts: [{ artifactId: "artifact-uploaded" }],
  analyses: [{ artifactId: "artifact-uploaded" }],
}));
const completeCheck = vi.fn(async () => ({
  assessmentReady: true,
  assessment: { id: "assessment-1" },
  grade: "A",
  issueCount: 0,
}));
const getCheck = vi.fn(async () => ({ artifacts: [], analyses: [] }));
const clearDraft = vi.fn(async () => {});
const getDraft = vi.fn(async () => null);
const markAnalyzing = vi.fn();
const markAnalysisFailed = vi.fn();
const markSubmitted = vi.fn();
const markUploading = vi.fn();
const getCurrentCheck = vi.fn(() => null);
const getPlaceOrder = vi.fn(() => ["place-north"]);

vi.mock("./api.js", () => ({
  createCheck,
  uploadArtifact,
  registerArtifact,
  registerTextArtifact,
  waitForAnalyses,
  completeCheck,
  getCheck,
  ApiError,
}));

vi.mock("../db.js", () => ({
  clearDraft,
  getDraft,
}));

vi.mock("../domain/check-adapter.js", () => ({
  analysesToFindings: vi.fn(() => []),
}));

vi.mock("../state/check-session.js", () => ({
  getCurrentCheck,
  markUploading,
  markAnalyzing,
  markAnalysisFailed,
  getPlaceOrder,
  markSubmitted,
}));

vi.mock("./instrument.js", () => ({
  startRun: vi.fn(),
  span: vi.fn(() => vi.fn()),
  mark: vi.fn(),
}));

function makeDraft() {
  return {
    id: "check-1",
    flowType: "single-problem",
    placeOrder: ["place-north"],
    submittedAt: "2026-08-27T00:21:00.000Z",
    places: {
      "place-north": {
        id: "place-north",
        name: "North",
        skipped: false,
        description: null,
        items: [
          {
            id: "item-1",
            placeId: "place-north",
            placeName: "North",
            dataUrl: "data:image/jpeg;base64,AA==",
            uploadedAt: "2026-08-27T00:20:00.000Z",
          },
        ],
      },
    },
  };
}

describe("resumeUploadingCheck", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getDraft.mockResolvedValue(makeDraft());
    getCheck.mockResolvedValue({
      artifacts: [],
      analyses: [],
    });
  });

  it("resumes a persisted uploading session from the saved draft", async () => {
    const { resumeUploadingCheck } = await import("./submit-check.js");

    await resumeUploadingCheck("check-1", {
      flowType: "single-problem",
      submissionKind: "problem_report",
    });

    expect(createCheck).toHaveBeenCalledWith("check-1", {
      places: [{ placeId: "place-north", placeName: "North", skipped: false }],
    });
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    expect(markAnalyzing).toHaveBeenCalledWith({
      submissionKind: "problem_report",
      expectedArtifacts: 1,
      checkId: "check-1",
    });
    expect(clearDraft).toHaveBeenCalledTimes(2);
    expect(waitForAnalyses).toHaveBeenCalledTimes(1);
    expect(completeCheck).toHaveBeenCalledTimes(1);
  });

  it("skips artifacts already registered before reload", async () => {
    const { resumeUploadingCheck } = await import("./submit-check.js");
    getCheck.mockResolvedValue({
      artifacts: [
        {
          placeId: "place-north",
          placeName: "North",
          capturedAt: "2026-08-27T00:20:00.000Z",
          s3Key: "checks/site/check-1/existing.jpg",
        },
      ],
      analyses: [],
    });

    await resumeUploadingCheck("check-1", {
      flowType: "single-problem",
      submissionKind: "problem_report",
    });

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(waitForAnalyses).toHaveBeenCalledWith("check-1", { expected: 1 });
  });
});

function makeEagerDraft() {
  const draft = makeDraft();
  draft.places["place-north"].items[0].upload = {
    status: "uploaded",
    artifactId: "artifact-eager",
    s3Key: "checks/site/check-1/eager.jpg",
    contentType: "image/jpeg",
  };
  // The eager upload swapped the full-res bytes for a thumbnail.
  draft.places["place-north"].items[0].dataUrl =
    "data:image/jpeg;base64,THUMB==";
  return draft;
}

describe("eager-uploaded photos register instead of re-uploading", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getDraft.mockResolvedValue(makeEagerDraft());
    getCheck.mockResolvedValue({ artifacts: [], analyses: [] });
  });

  it("registers the stored artifact and never re-uploads the bytes", async () => {
    const { resumeUploadingCheck } = await import("./submit-check.js");

    await resumeUploadingCheck("check-1", {
      flowType: "single-problem",
      submissionKind: "problem_report",
    });

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(registerArtifact).toHaveBeenCalledTimes(1);
    expect(registerArtifact).toHaveBeenCalledWith("check-1", {
      artifactId: "artifact-eager",
      placeId: "place-north",
      placeName: "North",
      s3Key: "checks/site/check-1/eager.jpg",
      contentType: "image/jpeg",
      capturedAt: "2026-08-27T00:20:00.000Z",
    });
    expect(markAnalyzing).toHaveBeenCalledWith({
      submissionKind: "problem_report",
      expectedArtifacts: 1,
      checkId: "check-1",
    });
  });

  it("tolerates a 409 (already registered) on replay", async () => {
    registerArtifact.mockRejectedValueOnce(
      new ApiError("conflict", { status: 409 }),
    );
    const { resumeUploadingCheck } = await import("./submit-check.js");

    await expect(
      resumeUploadingCheck("check-1", {
        flowType: "single-problem",
        submissionKind: "problem_report",
      }),
    ).resolves.toBeDefined();

    expect(completeCheck).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-409 register failure", async () => {
    registerArtifact.mockRejectedValueOnce(
      new ApiError("server", { status: 500 }),
    );
    const { resumeUploadingCheck } = await import("./submit-check.js");

    await expect(
      resumeUploadingCheck("check-1", {
        flowType: "single-problem",
        submissionKind: "problem_report",
      }),
    ).rejects.toBeDefined();
  });
});

describe("submitCheck / resumeSubmittedCheck", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCurrentCheck.mockReturnValue(makeDraft());
  });

  it("routes initial and resumed finalization through one registry", async () => {
    /** @type {null | (() => void)} */
    let releaseAnalyses = null;
    waitForAnalyses.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAnalyses = () =>
            resolve({
              artifacts: [{ artifactId: "artifact-uploaded" }],
              analyses: [{ artifactId: "artifact-uploaded" }],
            });
        }),
    );

    const { submitCheck, resumeSubmittedCheck } = await import(
      "./submit-check.js"
    );

    submitCheck({ submissionKind: "problem_report" });
    // Let submit's background pipeline (create → settle eager uploads → upload →
    // finalize) reach waitForAnalyses, so it registers in the finalization registry
    // before the resume below — which must then dedupe onto it rather than start a
    // second finalization. Flush microtasks until submit parks on the analyses
    // promise (releaseAnalyses is set the moment its waitForAnalyses is called).
    for (let i = 0; i < 50 && !releaseAnalyses; i++) {
      await Promise.resolve();
    }

    const resumed = resumeSubmittedCheck("check-1", { expectedArtifacts: 1 });
    expect(releaseAnalyses).toBeTypeOf("function");
    if (!releaseAnalyses) {
      throw new Error("Expected analysis release callback");
    }
    releaseAnalyses();
    await resumed;

    expect(waitForAnalyses).toHaveBeenCalledTimes(1);
    expect(completeCheck).toHaveBeenCalledTimes(1);
  });
});
