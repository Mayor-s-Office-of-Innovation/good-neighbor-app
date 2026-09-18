import { beforeEach, expect, it, vi } from "vitest";

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
  ApiError: class ApiError extends Error {},
  LEG: { PRESIGN: "presign", PUT: "put", REGISTER: "register" },
}));
vi.mock("./device-location.js", () => ({
  getCaptureDeviceLocation: vi.fn(),
}));
vi.mock("../state/check-session.js", () => ({
  addItem: vi.fn(),
  getCurrentCheck: vi.fn(),
  getPlaceOrder: vi.fn(),
  updateItem: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));

import { evaluateAssessment, getCheck, registerTextArtifact } from "./api.js";
import { getCaptureDeviceLocation } from "./device-location.js";
import {
  addItem,
  getCurrentCheck,
  updateItem,
} from "../state/check-session.js";
import { analyzeNoIssueDescriptionEdit } from "./photo-analysis.js";

beforeEach(() => vi.resetAllMocks());

it("stores capture location on a generated text report", async () => {
  const originalItem = { id: "original" };
  vi.mocked(getCurrentCheck).mockReturnValue(
    /** @type {any} */ ({
      id: "check",
      remoteStarted: true,
      places: {
        sidewalk: {
          id: "sidewalk",
          name: "Sidewalk",
          items: [originalItem],
        },
      },
    }),
  );
  vi.mocked(getCaptureDeviceLocation).mockResolvedValue(location);
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

  await analyzeNoIssueDescriptionEdit(
    "sidewalk",
    "original",
    "Litter by the door",
  );

  expect(addItem).toHaveBeenCalledWith(
    "sidewalk",
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
    "sidewalk",
    "generated",
    expect.objectContaining({
      upload: { status: "uploaded", artifactId: "artifact" },
    }),
  );
});
