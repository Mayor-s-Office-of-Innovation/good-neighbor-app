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
  getCheck: () => null,
  markScorecardDone: vi.fn(),
  clearSubmittedSession: vi.fn(async () => {}),
  updateCheckRecovery: vi.fn(async (id, recovery) => {
    const check = getCurrentCheck();
    if (check) check.finalizationRecovery = recovery;
  }),
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
    submittedAt: "2026-08-27T00:21:00.000Z",
    items: [
      {
        id: "item-1",
        analysis: { status: "analyzed" },
        dataUrl: "data:image/jpeg;base64,AA==",
        uploadedAt: "2026-08-27T00:20:00.000Z",
      },
    ],
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
    draft.items.push(
      /** @type {any} */ ({
        id: "item-2",
        kind: "text",
        text: "There is litter near the entrance.",
        uploadedAt: "2026-08-27T00:22:00.000Z",
      }),
    );

    expect(expectedArtifactCountForCheck(draft)).toBe(2);
  });

  it("marks the local scorecard done after successful server finalization", async () => {
    const { finalizeCaptureScorecardInBackground } = await import(
      "./submit-check.js"
    );
    const { markScorecardDone } = await import("../state/check-session.js");
    completeCheck.mockImplementationOnce(async () => {
      expect(markScorecardDone).not.toHaveBeenCalled();
      return { grade: "A", issueCount: 0 };
    });

    await finalizeCaptureScorecardInBackground("check-1", {
      expectedArtifacts: 1,
    });

    expect(waitForAnalyses).toHaveBeenCalledWith("check-1", { expected: 1 });
    expect(completeCheck).toHaveBeenCalledTimes(1);
    expect(markScorecardDone).toHaveBeenCalledExactlyOnceWith("check-1");
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
    draft.items = [
      /** @type {any} */ ({
        id: "item-text",
        kind: "text",
        text: "There is a large pothole near the north entrance.",
        uploadedAt: "2026-08-27T00:22:00Z",
      }),
    ];

    expect(expectedArtifactCountForCheck(draft)).toBe(1);

    await finalizeCaptureScorecardInBackground("check-1", {
      expectedArtifacts: 1,
    });
    expect(waitForAnalyses).toHaveBeenCalledWith("check-1", { expected: 1 });
    expect(completeCheck).toHaveBeenCalledTimes(1);
  });

  it("waits for guidance and recoverable uploads rather than finalizing early", async () => {
    const {
      finalizeCaptureScorecardInBackground,
      expectedArtifactCountForCheck,
    } = await import("./submit-check.js");
    const draft = makeDraft();
    draft.items[0].analysis = /** @type {any} */ ({
      status: "failed",
      recovery: { stage: "upload", state: "manual", attempts: 3 },
    });
    getCurrentCheck.mockReturnValue(draft);
    expect(expectedArtifactCountForCheck(draft)).toBe(1);
    expect(
      finalizeCaptureScorecardInBackground(draft.id, { expectedArtifacts: 1 }),
    ).toBeNull();
    expect(completeCheck).not.toHaveBeenCalled();
  });

  it("persists automatic finalization exhaustion and shares a manual attempt", async () => {
    const { finalizeCaptureScorecardInBackground } = await import(
      "./submit-check.js"
    );
    const draft = /** @type {any} */ (makeDraft());
    draft.finalizationRecovery = {
      stage: "complete",
      attempts: 3,
      state: "scheduled",
    };
    getCurrentCheck.mockReturnValue(draft);
    completeCheck.mockRejectedValueOnce(
      Object.assign(new Error("unavailable"), { status: 503 }),
    );
    await expect(
      finalizeCaptureScorecardInBackground(draft.id, { expectedArtifacts: 1 }),
    ).rejects.toThrow("unavailable");
    expect(draft.finalizationRecovery.state).toBe("manual");
    expect(
      finalizeCaptureScorecardInBackground(draft.id, { expectedArtifacts: 1 }),
    ).toBeNull();
    const first = finalizeCaptureScorecardInBackground(draft.id, {
      expectedArtifacts: 1,
      manual: true,
    });
    expect(
      finalizeCaptureScorecardInBackground(draft.id, {
        expectedArtifacts: 1,
        manual: true,
      }),
    ).toBe(first);
    await first;
    expect(completeCheck).toHaveBeenCalledTimes(2);
    expect(draft.finalizationRecovery).toBeUndefined();
  });

  it("excludes permanently failed unregistered items from the coverage target", async () => {
    // Review finding 3: five photos whose uploads permanently failed used to
    // count toward `expected`, so the backend (with 0 ART# rows) could never
    // satisfy the coverage gate and the finalization timed out forever. A dead
    // item must not be expected; a registered-but-failed one still is (its
    // backend artifact exists, its failure marker satisfies the gate).
    const { expectedArtifactCountForCheck } = await import("./submit-check.js");
    const draft = makeDraft();
    draft.items = [
      /** @type {any} */ ({
        id: "dead-photo",
        kind: "photo",
        dataUrl: "data:image/jpeg;base64,AA==",
        upload: { status: "failed" },
        analysis: { status: "failed" },
        uploadedAt: "2026-08-27T00:20:00Z",
      }),
      /** @type {any} */ ({
        id: "registered-failed",
        kind: "photo",
        upload: { status: "uploaded", artifactId: "art-9" },
        analysis: { status: "failed", artifactId: "art-9" },
        uploadedAt: "2026-08-27T00:20:00Z",
      }),
      /** @type {any} */ ({
        id: "dead-text",
        kind: "text",
        text: "Never registered.",
        upload: { status: "failed" },
        analysis: { status: "failed" },
        uploadedAt: "2026-08-27T00:22:00Z",
      }),
    ];

    // Only the registered (though analysis-failed) artifact is expected.
    expect(expectedArtifactCountForCheck(draft)).toBe(1);
  });
});

it("settles an emptied finished check locally without synthesizing a scorecard", async () => {
  const session = await import("../state/check-session.js");
  const { finalizeCaptureScorecardInBackground } = await import(
    "./submit-check.js"
  );
  getCurrentCheck.mockReturnValue({
    id: "empty-check",
    status: "capture-complete",
    items: [],
  });
  completeCheck.mockClear();
  waitForAnalyses.mockClear();
  await finalizeCaptureScorecardInBackground("empty-check", {
    expectedArtifacts: 1,
  });
  expect(session.markScorecardDone).toHaveBeenCalledWith("empty-check");
  expect(session.clearSubmittedSession).toHaveBeenCalledWith("empty-check");
  expect(completeCheck).not.toHaveBeenCalled();
  expect(waitForAnalyses).not.toHaveBeenCalled();
});

it("settles unregistered terminal failures but preserves their local cards", async () => {
  const session = await import("../state/check-session.js");
  const {
    expectedArtifactCountForCheck,
    finalizeCaptureScorecardInBackground,
  } = await import("./submit-check.js");
  const check = {
    id: "failed-check",
    status: "capture-complete",
    items: [
      {
        id: "photo",
        kind: "photo",
        dataUrl: "data:,",
        upload: { artifactId: "reserved", status: "uploading" },
        analysis: { status: "failed", recovery: { state: "blocked" } },
      },
    ],
  };
  getCurrentCheck.mockReturnValue(check);
  vi.mocked(session.clearSubmittedSession).mockClear();
  expect(expectedArtifactCountForCheck(check)).toBe(0);
  await finalizeCaptureScorecardInBackground(check.id);
  expect(session.markScorecardDone).toHaveBeenCalledWith(check.id);
  expect(session.clearSubmittedSession).not.toHaveBeenCalled();
  expect(check.items).toHaveLength(1);
});

it("waits for deletion confirmation even when the remaining evidence count is zero", async () => {
  const session = await import("../state/check-session.js");
  const { finalizeCaptureScorecardInBackground } = await import(
    "./submit-check.js"
  );
  getCurrentCheck.mockReturnValue({
    id: "deleting-check",
    status: "capture-complete",
    items: [
      {
        kind: "photo",
        deletionPending: true,
        analysis: { status: "failed", recovery: { state: "blocked" } },
      },
    ],
  });
  vi.mocked(session.clearSubmittedSession).mockClear();
  completeCheck.mockClear();
  expect(finalizeCaptureScorecardInBackground("deleting-check")).toBeNull();
  expect(completeCheck).not.toHaveBeenCalled();
  expect(session.clearSubmittedSession).not.toHaveBeenCalled();
});

it("preserves warning expiry across replacement and removes retry after authoritative completion", async () => {
  vi.useFakeTimers();
  const notices = await import("../components/error-notice.js");
  const target = { isConnected: true };
  let connected = true;
  const close = vi.fn();
  const show = vi.spyOn(notices, "showInlineError").mockReturnValue({
    close,
    isConnected: () => connected,
  });
  const draft = /** @type {any} */ (makeDraft());
  draft.finalizationRecovery = { state: "manual" };
  getCurrentCheck.mockReturnValue(draft);
  vi.stubGlobal("document", { querySelector: () => target });
  try {
    const { finalizeCaptureScorecardInBackground, restoreFinalizationNotices } =
      await import("./submit-check.js");
    expect(finalizeCaptureScorecardInBackground(draft.id)).toBeNull();
    expect(show).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        duration: 5000,
        retainRetryOnExpiry: true,
        retry: expect.any(Function),
      }),
    );
    const count = show.mock.calls.length;
    finalizeCaptureScorecardInBackground(draft.id);
    expect(show).toHaveBeenCalledTimes(count);
    vi.advanceTimersByTime(5001);
    connected = false;
    finalizeCaptureScorecardInBackground(draft.id);
    expect(show).toHaveBeenCalledTimes(count + 1);
    expect(show).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        duration: 0,
        expired: true,
        retainRetryOnExpiry: true,
      }),
    );
    close.mockClear();
    getCurrentCheck.mockReturnValue(null);
    restoreFinalizationNotices(null, target);
    expect(close).toHaveBeenCalledOnce();
    restoreFinalizationNotices(null, target);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    show.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
