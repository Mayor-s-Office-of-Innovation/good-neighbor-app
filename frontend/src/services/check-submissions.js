/*
  Background sender for checks and problem reports — the check counterpart of
  care-submissions.js. Evidence items are already saved on the device as they
  are captured (state/check-session.js mirrors every change to IndexedDB), so
  this only decides WHEN to send what is waiting:

  - Items saved with no connection (analysis status `waiting`), and items
    whose upload or analysis was interrupted by a reload or app close, are
    sent again through the normal per-item pipeline (photo-analysis.js
    `analyzeEvidenceItem`), which skips whatever already reached the server.
    Every step is idempotent on the client ids.
  - A finished check gets its run-level scorecard (submit-check.js) once every
    live item has a registered artifact, then is marked done so it is not
    re-run. Home drops it once the backend history shows it.

  Triggers: app start, `online`, `pageshow`, returning to the app,
  `sitebound`, the backend coming back (backend-health.js), and a retry every
  minute while items wait (a weak signal may never fire `online`). Each
  finished item run re-checks only the scorecards, never restarts uploads, so
  an offline device cannot spin.
  Like care work, sending pauses while the app is closed: there is no
  background sync (iOS does not support it).
*/
import { getSite } from "../db.js";
import {
  getCurrentCheck,
  loadFinishedChecks,
  markScorecardDone,
} from "../state/check-session.js";
import {
  analyzeEvidenceItem,
  hasUnsentLocation,
  resendItemLocation,
  EVIDENCE_SETTLED_EVENT,
  shouldResumeEvidenceItem,
} from "./photo-analysis.js";
import {
  expectedArtifactCountForCheck,
  finalizeCaptureScorecardInBackground,
} from "./submit-check.js";
import { checkItems, itemHasLiveEvidence } from "../domain/check-completion.js";

/**
 * Every live item has reached the server, so the scorecard can be built.
 * @param {any} check
 */
export function readyForScorecard(check) {
  return checkItems(check).every(
    (item) =>
      !itemHasLiveEvidence(item) ||
      Boolean(item.analysis?.artifactId || item.upload?.artifactId),
  );
}

/** @param {any} check */
function finalize(check) {
  if (check.status !== "capture-complete" || check.scorecardDone) return;
  if (!readyForScorecard(check)) return;
  const run = finalizeCaptureScorecardInBackground(check.id, {
    expectedArtifacts:
      check.expectedArtifacts ?? expectedArtifactCountForCheck(check),
  });
  void run?.then(
    () => markScorecardDone(check.id),
    () => {
      /* Logged by submit-check; the next trigger tries again. */
    },
  );
}

/**
 * The bound site's held checks: every finished one plus the check on screen.
 * @param {{ siteId: string }} site
 */
async function heldChecks(site) {
  const checks = await loadFinishedChecks(site.siteId).catch(() => []);
  const inProgress = getCurrentCheck();
  if (inProgress?.status === "in-progress") checks.push(inProgress);
  return checks.filter((check) => check.siteId === site.siteId);
}

// While items wait, try again this often. On a weak signal the browser may
// never fire `online`, and the health probe backs off to 5 minutes.
export const WAITING_RETRY_MS = 60_000;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;

/**
 * Restart waiting items and build any scorecards that are ready.
 * @param {{ uploads?: boolean }} [options] false: scorecards only
 */
export async function resumeCheckSubmissions({ uploads = true } = {}) {
  try {
    const site = await getSite();
    if (!site?.siteId) return;
    const offline = globalThis.navigator?.onLine === false;
    let waiting = false;
    for (const check of await heldChecks(site)) {
      for (const item of checkItems(check)) {
        if (item.analysis?.status === "waiting") waiting = true;
        if (uploads && !offline && shouldResumeEvidenceItem(item))
          analyzeEvidenceItem(item.id);
        if (hasUnsentLocation(item)) {
          waiting = true;
          if (uploads && !offline) void resendItemLocation(check.id, item);
        }
      }
      finalize(check);
    }
    scheduleRetry(waiting);
  } catch {
    /* Storage failure must not prevent app startup. */
  }
}

/** @param {boolean} waiting */
function scheduleRetry(waiting) {
  if (!waiting || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    // A hidden page retries on `pageshow` / visibility instead.
    if (globalThis.document?.visibilityState === "hidden") return;
    void resumeCheckSubmissions();
  }, WAITING_RETRY_MS);
}

let started = false;

export function startCheckSubmissionRecovery() {
  if (started) return;
  started = true;
  const resume = () => {
    void resumeCheckSubmissions();
  };
  window.addEventListener("connectionretry", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("sitebound", resume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resume();
  });
  window.addEventListener(EVIDENCE_SETTLED_EVENT, () => {
    void resumeCheckSubmissions({ uploads: false });
  });
  resume();
}
