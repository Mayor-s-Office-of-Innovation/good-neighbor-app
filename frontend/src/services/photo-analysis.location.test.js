import { afterEach, beforeEach, expect, it, vi } from "vitest";

const location = { latitude: 37.7793, longitude: -122.4192 };

vi.mock("./api.js", () => ({
  createCheck: vi.fn(),
  evaluateAssessment: vi.fn(),
  getAssessmentGuidance: vi.fn(),
  getCheck: vi.fn(),
  registerArtifact: vi.fn(),
  registerTextArtifact: vi.fn(),
  submitConditionAnswers: vi.fn(),
  uploadArtifact: vi.fn(),
  updateArtifactLocation: vi.fn(),
  ApiError: class ApiError extends Error {},
  LEG: { PRESIGN: "presign", PUT: "put", REGISTER: "register" },
}));
vi.mock("./device-location.js", () => ({
  readCaptureDeviceLocation: vi.fn(),
}));
vi.mock("../state/check-session.js", () => ({
  findCheckForItem: vi.fn(() => null),
  getCheck: vi.fn(() => null),
  addItem: vi.fn(),
  getCurrentCheck: vi.fn(),
  updateItem: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));

import {
  evaluateAssessment,
  getCheck,
  registerTextArtifact,
  updateArtifactLocation,
  uploadArtifact,
} from "./api.js";
import { readCaptureDeviceLocation } from "./device-location.js";
import {
  addItem,
  getCurrentCheck,
  updateItem,
} from "../state/check-session.js";
import {
  analyzeEvidenceItem,
  analyzeNoIssueDescriptionEdit,
} from "./photo-analysis.js";

beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  const { cancelCheckPolling } = await import("./check-polling.js");
  cancelCheckPolling("check");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** @returns {{ promise: Promise<any>, resolve: (value: any) => void }} */
function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

const analyzed = {
  analyses: [
    {
      artifactId: "artifact",
      status: "analyzed",
      analyzedAt: "2026-09-15T10:00:00Z",
      concerns: [{ category: "Litter", rating: 1 }],
    },
  ],
};

it("stores capture location on a generated text report", async () => {
  const originalItem = { id: "original" };
  vi.mocked(getCurrentCheck).mockReturnValue(
    /** @type {any} */ ({
      id: "check",
      remoteStarted: true,
      items: [originalItem],
    }),
  );
  vi.mocked(readCaptureDeviceLocation).mockReturnValue({
    atUpload: () => location,
    later: Promise.resolve(location),
  });
  vi.mocked(registerTextArtifact).mockResolvedValue("artifact");
  vi.mocked(getCheck).mockResolvedValue(
    /** @type {any} */ ({
      analyses: [
        {
          artifactId: "artifact",
          status: "analyzed",
          analyzedAt: "2026-09-15T10:00:00Z",
          concerns: [
            {
              category: "Litter",
              rating: 1,
              userFriendlyLabel: "Trash scattered by doorway",
            },
          ],
        },
      ],
    }),
  );
  vi.mocked(evaluateAssessment).mockResolvedValue(
    /** @type {any} */ ({
      assessment: { assessmentId: "assessment" },
      conditions: [{ conditionId: "condition" }],
      tasks: [],
    }),
  );
  vi.mocked(addItem).mockReturnValue(/** @type {any} */ ({ id: "generated" }));

  await analyzeNoIssueDescriptionEdit("original", "Litter by the door");

  expect(addItem).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "text",
      text: "Litter by the door",
      location,
    }),
  );
  expect(evaluateAssessment).toHaveBeenCalledWith(
    expect.objectContaining({
      conditions: [
        expect.objectContaining({
          category: "Litter",
          userFriendlyLabel: "Trash scattered by doorway",
        }),
      ],
    }),
  );
  expect(updateItem).toHaveBeenCalledWith(
    "generated",
    expect.objectContaining({
      upload: { status: "uploaded", artifactId: "artifact" },
    }),
  );
});

/** @param {string} id */
function photoCheck(id) {
  const photo = { id, kind: "photo", dataUrl: "data:image/jpeg;base64,AA" };
  const check = {
    id: "check",
    flowType: "perimeter",
    remoteStarted: true,
    items: [photo],
  };
  vi.mocked(getCurrentCheck).mockReturnValue(/** @type {any} */ (check));
  vi.mocked(updateItem).mockImplementation((itemId, patch) =>
    Object.assign(photo, patch),
  );
  vi.mocked(evaluateAssessment).mockResolvedValue(
    /** @type {any} */ ({ assessment: {}, conditions: [], tasks: [] }),
  );
  return photo;
}

it("uploads before the location arrives, then sends it", async () => {
  photoCheck("late-fix");
  const fix = deferred();
  vi.mocked(readCaptureDeviceLocation).mockReturnValue({
    atUpload: () => null,
    later: fix.promise,
  });
  /** @type {unknown} */
  let sentWithPhoto;
  vi.mocked(uploadArtifact).mockImplementation(async (_checkId, opts) => {
    sentWithPhoto = opts.location?.();
    return /** @type {any} */ ({ artifactId: "artifact", s3Key: "k" });
  });
  vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ (analyzed));

  analyzeEvidenceItem("late-fix");
  await vi.waitFor(() => expect(evaluateAssessment).toHaveBeenCalled());
  expect(sentWithPhoto).toBeNull();
  expect(updateArtifactLocation).not.toHaveBeenCalled();

  fix.resolve(location);
  await vi.waitFor(() =>
    expect(updateArtifactLocation).toHaveBeenCalledWith(
      "check",
      "artifact",
      location,
    ),
  );
  expect(updateItem).toHaveBeenCalledWith("late-fix", { location });
});

it("puts a location that beat the analysis on the photo's tasks", async () => {
  photoCheck("fix-before-analysis");
  const fix = deferred();
  vi.mocked(readCaptureDeviceLocation).mockReturnValue({
    atUpload: () => null,
    later: fix.promise,
  });
  vi.mocked(uploadArtifact).mockResolvedValue(
    /** @type {any} */ ({ artifactId: "artifact", s3Key: "k" }),
  );
  const analysis = deferred();
  vi.mocked(getCheck).mockReturnValue(analysis.promise);

  analyzeEvidenceItem("fix-before-analysis");
  fix.resolve(location);
  await vi.waitFor(() => expect(updateArtifactLocation).toHaveBeenCalled());
  analysis.resolve(analyzed);
  await vi.waitFor(() =>
    expect(evaluateAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        assessment: {
          metadata: expect.objectContaining({
            latitude: location.latitude,
            longitude: location.longitude,
          }),
        },
      }),
    ),
  );
});

it("sends a location that was ready with the photo and never again", async () => {
  photoCheck("ready-fix");
  vi.mocked(readCaptureDeviceLocation).mockReturnValue({
    atUpload: () => location,
    later: Promise.resolve(location),
  });
  /** @type {unknown} */
  let sentWithPhoto;
  vi.mocked(uploadArtifact).mockImplementation(async (_checkId, opts) => {
    sentWithPhoto = opts.location?.();
    return /** @type {any} */ ({ artifactId: "artifact", s3Key: "k" });
  });
  vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ (analyzed));

  analyzeEvidenceItem("ready-fix");
  await vi.waitFor(() => expect(evaluateAssessment).toHaveBeenCalled());
  expect(sentWithPhoto).toEqual(location);
  expect(updateArtifactLocation).not.toHaveBeenCalled();
});

it("registers an edited description before its location arrives", async () => {
  vi.mocked(getCurrentCheck).mockReturnValue(
    /** @type {any} */ ({
      id: "check",
      remoteStarted: true,
      items: [{ id: "original" }],
    }),
  );
  const fix = deferred();
  vi.mocked(readCaptureDeviceLocation).mockReturnValue({
    atUpload: () => null,
    later: fix.promise,
  });
  vi.mocked(registerTextArtifact).mockResolvedValue("artifact");
  vi.mocked(getCheck).mockResolvedValue(/** @type {any} */ (analyzed));
  vi.mocked(evaluateAssessment).mockResolvedValue(
    /** @type {any} */ ({ assessment: {}, conditions: [], tasks: [] }),
  );

  await analyzeNoIssueDescriptionEdit("original", "Litter by the door");
  expect(registerTextArtifact).toHaveBeenCalledWith(
    "check",
    expect.not.objectContaining({ latitude: expect.anything() }),
  );
  fix.resolve(location);
  await vi.waitFor(() =>
    expect(updateArtifactLocation).toHaveBeenCalledWith(
      "check",
      "artifact",
      location,
    ),
  );
});
