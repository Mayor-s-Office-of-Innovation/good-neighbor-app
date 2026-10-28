import { afterEach, expect, it, vi } from "vitest";
import { pollCheck, cancelCheckPolling } from "./check-polling.js";
import {
  startCheck,
  markCaptureComplete,
  getCurrentCheck,
  pauseCheck,
  clearCheck,
} from "../state/check-session.js";
import { analyzeEvidenceItem } from "./photo-analysis.js";
import { finalizeCaptureScorecardInBackground } from "./submit-check.js";
import { getCheck, completeCheck } from "./api.js";
import { saveDraft } from "../db.js";

vi.mock("../db.js", () => ({
  newId: () => crypto.randomUUID(),
  getSite: vi.fn(async () => ({ siteId: "site-1" })),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(),
  getDraft: vi.fn(),
  saveFinishedCheck: vi.fn(),
  listFinishedChecks: vi.fn(async () => []),
  deleteFinishedCheck: vi.fn(),
}));
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getCheck: vi.fn(),
  completeCheck: vi.fn(async () => ({})),
  waitForAnalyses: (id) =>
    pollCheck(id, getCheck, (snapshot) =>
      snapshot.analyses.length ? snapshot : undefined,
    ),
}));

afterEach(() => {
  clearCheck();
  vi.clearAllMocks();
});

it("finishes the submitted check while a new capture is active", async () => {
  const previous = startCheck("site-1");
  markCaptureComplete();
  /** @type {(snapshot: any) => void} */
  let respond = () => {
    throw new Error("No pending read");
  };
  vi.mocked(getCheck).mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const finalized = finalizeCaptureScorecardInBackground(previous.id, {
    expectedArtifacts: 1,
  });
  await vi.waitFor(() => expect(getCheck).toHaveBeenCalled());
  const next = startCheck("site-1");
  respond({ check: {}, artifacts: [{}], analyses: [{}] });
  await finalized;
  expect(completeCheck).toHaveBeenCalledWith(previous.id);
  expect(getCurrentCheck()).toBe(next);
  cancelCheckPolling(previous.id);
});

it("does not persist an analysis failure while pause waits for draft storage", async () => {
  const check = startCheck("site-1");
  Object.assign(check, { remoteStarted: true });
  const item = {
    id: "photo-paused",
    kind: "photo",
    location: { latitude: 37, longitude: -122 },
    upload: { status: "uploaded", artifactId: "artifact-1" },
    analysis: { artifactId: "artifact-1" },
  };
  check.items.push(item);
  vi.mocked(getCheck).mockImplementation(() => new Promise(() => {}));
  analyzeEvidenceItem(item.id);
  await vi.waitFor(() => expect(getCheck).toHaveBeenCalled());
  /** @type {() => void} */
  let finishSave = () => {
    throw new Error("No pending save");
  };
  vi.mocked(saveDraft).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = () => resolve(undefined);
      }),
  );
  const paused = pauseCheck();
  // The canceled analysis promise settles while the old session is still current.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getCurrentCheck()).toBe(check);
  expect(item.analysis.status).toBe("analyzing");
  expect(item.analysis.failure).toBeUndefined();
  expect(item.upload.status).toBe("uploaded");
  finishSave();
  await paused;
  expect(getCurrentCheck()).toBeNull();
});
