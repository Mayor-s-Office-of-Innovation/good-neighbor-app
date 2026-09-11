import { beforeEach, describe, expect, it, vi } from "vitest";

const completeCheck = vi.fn(async () => ({
  grade: "A",
  issueCount: 0,
}));
const waitForAnalyses = vi.fn(async () => ({
  artifacts: [{ artifactId: "artifact-uploaded" }],
  analyses: [{ artifactId: "artifact-uploaded" }],
}));
const getCurrentCheck = vi.fn(() => null);

vi.mock("./api.js", () => ({
  waitForAnalyses,
  completeCheck,
}));

vi.mock("../db.js", () => ({
  clearDraft: vi.fn(async () => {}),
  getDraft: vi.fn(async () => null),
}));

vi.mock("../state/check-session.js", () => ({
  getCurrentCheck,
  getPlaceOrder: vi.fn(() => ["place-north"]),
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

describe("capture scorecard finalization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCurrentCheck.mockReturnValue(makeDraft());
    waitForAnalyses.mockResolvedValue({
      artifacts: [{ artifactId: "artifact-uploaded" }],
      analyses: [{ artifactId: "artifact-uploaded" }],
    });
  });

  it("counts already captured evidence without registering anything on Done", async () => {
    const { expectedArtifactCountForCheck } = await import("./submit-check.js");
    const draft = makeDraft();
    draft.places["place-north"].items.push(
      /** @type {any} */ ({
        id: "item-2",
        kind: "text",
        placeId: "place-north",
        placeName: "North",
        text: "There is litter near the entrance.",
        uploadedAt: "2026-08-27T00:22:00.000Z",
      }),
    );

    expect(expectedArtifactCountForCheck(draft)).toBe(2);
  });

  it("finalizes the run-level scorecard without changing visible submitted state", async () => {
    const { finalizeCaptureScorecardInBackground } = await import(
      "./submit-check.js"
    );

    await finalizeCaptureScorecardInBackground("check-1", {
      expectedArtifacts: 1,
    });

    expect(waitForAnalyses).toHaveBeenCalledWith("check-1", { expected: 1 });
    expect(completeCheck).toHaveBeenCalledTimes(1);
  });

  it("skips background scorecard finalization when capture has no evidence", async () => {
    const { finalizeCaptureScorecardInBackground } = await import(
      "./submit-check.js"
    );

    const result = finalizeCaptureScorecardInBackground("check-1", {
      expectedArtifacts: 0,
    });

    expect(result).toBeNull();
    expect(waitForAnalyses).not.toHaveBeenCalled();
    expect(completeCheck).not.toHaveBeenCalled();
  });

  it("counts a converted describe-only text item so Done files the report", async () => {
    // Finding 1 (PR review 192): a text-only problem report used to contribute
    // 0 expected artifacts (place.description was never counted), so Done
    // silently dropped it. Describe-instead now converts the description into
    // a kind:"text" item through the same pipeline as photos — this asserts the
    // counter and the finalization path accept that item.
    const {
      expectedArtifactCountForCheck,
      finalizeCaptureScorecardInBackground,
    } = await import("./submit-check.js");
    const draft = makeDraft();
    draft.places["place-north"].items = [
      /** @type {any} */ ({
        id: "item-text",
        kind: "text",
        placeId: "place-north",
        placeName: "North",
        text: "There is a large pothole near the north entrance.",
        uploadedAt: "2026-08-27T00:22:00.000Z",
      }),
    ];
    draft.places["place-north"].description = null;

    expect(expectedArtifactCountForCheck(draft)).toBe(1);

    await finalizeCaptureScorecardInBackground("check-1", {
      expectedArtifacts: 1,
    });
    expect(waitForAnalyses).toHaveBeenCalledWith("check-1", { expected: 1 });
    expect(completeCheck).toHaveBeenCalledTimes(1);
  });
});