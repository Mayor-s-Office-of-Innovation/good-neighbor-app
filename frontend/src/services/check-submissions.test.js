import { beforeEach, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => ({ finished: [], inProgress: null }));

vi.mock("../db.js", () => ({
  getSite: vi.fn(async () => ({ siteId: "site-1" })),
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => held.inProgress,
  loadFinishedChecks: vi.fn(async () => [...held.finished]),
  markScorecardDone: vi.fn(),
}));
vi.mock("./photo-analysis.js", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    analyzeEvidenceItem: vi.fn(),
    EVIDENCE_SETTLED_EVENT: actual.EVIDENCE_SETTLED_EVENT,
    shouldResumeEvidenceItem: actual.shouldResumeEvidenceItem,
  };
});
vi.mock("./submit-check.js", () => ({
  expectedArtifactCountForCheck: vi.fn(() => 1),
  finalizeCaptureScorecardInBackground: vi.fn(() => Promise.resolve({})),
}));

import { analyzeEvidenceItem } from "./photo-analysis.js";
import { finalizeCaptureScorecardInBackground } from "./submit-check.js";
import { markScorecardDone } from "../state/check-session.js";
import {
  readyForScorecard,
  resumeCheckSubmissions,
} from "./check-submissions.js";

const waiting = (id) => ({
  id,
  kind: "text",
  text: "Litter by the gate",
  analysis: { status: "waiting" },
});
const uploaded = (id) => ({
  id,
  kind: "text",
  text: "Litter by the gate",
  upload: { status: "uploaded", artifactId: `artifact-${id}` },
  analysis: { status: "analyzed", artifactId: `artifact-${id}` },
});
const finishedCheck = (id, items, extra = {}) => ({
  id,
  siteId: "site-1",
  status: "capture-complete",
  expectedArtifacts: items.length,
  items,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  held.finished = [];
  held.inProgress = null;
  vi.stubGlobal("navigator", { onLine: true });
});

describe("readyForScorecard", () => {
  it("waits until every live item has reached the server", () => {
    expect(readyForScorecard(finishedCheck("a", [uploaded("1")]))).toBe(true);
    expect(
      readyForScorecard(finishedCheck("a", [uploaded("1"), waiting("2")])),
    ).toBe(false);
  });

  it("ignores items that can never upload", () => {
    const dead = {
      id: "3",
      kind: "photo",
      analysis: { status: "failed" },
    };
    expect(readyForScorecard(finishedCheck("a", [uploaded("1"), dead]))).toBe(
      true,
    );
  });
});

describe("resumeCheckSubmissions", () => {
  it("restarts waiting items in every held check, finished or in progress", async () => {
    held.finished = [
      finishedCheck("a", [waiting("1")]),
      finishedCheck("b", [waiting("2")]),
    ];
    held.inProgress = {
      id: "c",
      siteId: "site-1",
      status: "in-progress",
      items: [waiting("3")],
    };
    await resumeCheckSubmissions();
    expect(vi.mocked(analyzeEvidenceItem).mock.calls.flat()).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(finalizeCaptureScorecardInBackground).not.toHaveBeenCalled();
  });

  it("does not restart uploads while the browser reports offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    held.finished = [finishedCheck("a", [waiting("1")])];
    await resumeCheckSubmissions();
    expect(analyzeEvidenceItem).not.toHaveBeenCalled();
  });

  it("only builds scorecards after an item run settles", async () => {
    held.finished = [
      finishedCheck("a", [waiting("1")]),
      finishedCheck("b", [uploaded("2")]),
    ];
    await resumeCheckSubmissions({ uploads: false });
    expect(analyzeEvidenceItem).not.toHaveBeenCalled();
    expect(finalizeCaptureScorecardInBackground).toHaveBeenCalledTimes(1);
    expect(finalizeCaptureScorecardInBackground).toHaveBeenCalledWith("b", {
      expectedArtifacts: 1,
    });
    await vi.waitFor(() => expect(markScorecardDone).toHaveBeenCalledWith("b"));
  });

  it("skips checks whose scorecard already landed or belong to another site", async () => {
    held.finished = [
      finishedCheck("a", [uploaded("1")], { scorecardDone: true }),
      finishedCheck("b", [uploaded("2")], { siteId: "site-2" }),
    ];
    await resumeCheckSubmissions();
    expect(finalizeCaptureScorecardInBackground).not.toHaveBeenCalled();
  });
});

describe("retry while items wait", () => {
  // A fresh module per test: the pending retry timer is module state.
  async function freshQueue() {
    vi.resetModules();
    const queue = await import("./check-submissions.js");
    const analysis = await import("./photo-analysis.js");
    return { queue, analyze: vi.mocked(analysis.analyzeEvidenceItem) };
  }

  it("tries waiting items again after a minute, once per minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { queue, analyze } = await freshQueue();
      held.finished = [finishedCheck("a", [waiting("1")])];
      await queue.resumeCheckSubmissions();
      await queue.resumeCheckSubmissions({ uploads: false });
      expect(analyze).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(queue.WAITING_RETRY_MS - 1);
      expect(analyze).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(analyze).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying once nothing is waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { queue, analyze } = await freshQueue();
      held.finished = [finishedCheck("a", [uploaded("1")])];
      await queue.resumeCheckSubmissions();
      await vi.advanceTimersByTimeAsync(queue.WAITING_RETRY_MS * 3);
      expect(analyze).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
