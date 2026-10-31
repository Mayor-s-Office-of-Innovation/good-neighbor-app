import { connectionAvailable } from "./evidence-recovery.js";
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
  minute while items wait, or the next persisted retry due time. Each
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
  removeEvidenceItem,
  reconcileFailedEvidence,
  hasUnsentLocation,
  resendItemLocation,
  EVIDENCE_SETTLED_EVENT,
  shouldResumeEvidenceItem,
} from "./photo-analysis.js";
import {
  expectedArtifactCountForCheck,
  finalizeCaptureScorecardInBackground,
} from "./submit-check.js";
import {
  hasRegisteredArtifact,
  needsRegistrationRepair,
  checkItems,
  itemHasLiveEvidence,
} from "../domain/check-completion.js";

/**
 * Every live item has guidance or a permanent terminal result.
 * @param {any} check
 */
export function readyForScorecard(check) {
  return checkItems(check).every(
    (item) =>
      !item.deletionPending &&
      (!itemHasLiveEvidence(item) ||
        (item.analysis?.status === "analyzed" && hasRegisteredArtifact(item)) ||
        item.analysis?.recovery?.state === "blocked"),
  );
}

/** @param {any} check */
function finalize(check) {
  if (check.status !== "capture-complete" || check.scorecardDone) return;
  if (!readyForScorecard(check)) return;
  const run = finalizeCaptureScorecardInBackground(check.id, {
    expectedArtifacts: expectedArtifactCountForCheck(check),
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
    const offline = !connectionAvailable();
    let waiting = false;
    let delay = WAITING_RETRY_MS;
    for (const check of await heldChecks(site)) {
      if (uploads && !offline)
        await reconcileFailedEvidence(check).catch(() => {});
      for (const item of checkItems(check)) {
        if (item.deletionPending) {
          waiting = true;
          if (uploads && !offline)
            void removeEvidenceItem(item.id).catch(() => {});
          continue;
        }
        if (
          item.analysis?.status === "waiting" ||
          needsRegistrationRepair(item)
        )
          waiting = true;
        if (item.analysis?.recovery?.state === "scheduled") {
          waiting = true;
          if (!offline)
            delay = Math.min(
              delay,
              Math.max(
                1000,
                (item.analysis.recovery.nextAttemptAt || 0) - Date.now(),
              ),
            );
        }
        if (uploads && !offline && shouldResumeEvidenceItem(item))
          analyzeEvidenceItem(item.id);
        if (hasUnsentLocation(item)) {
          waiting = true;
          if (uploads && !offline) void resendItemLocation(check.id, item);
        }
      }
      finalize(check);
      await Promise.resolve();
      if (
        check.status === "capture-complete" &&
        !check.scorecardDone &&
        !["manual", "blocked"].includes(check.finalizationRecovery?.state)
      ) {
        waiting = true;
        if (!offline)
          delay = Math.min(
            delay,
            Math.max(
              1000,
              (check.finalizationRecovery?.nextAttemptAt ||
                Date.now() + WAITING_RETRY_MS) - Date.now(),
            ),
          );
      }
    }
    scheduleRetry(waiting, delay);
  } catch {
    /* Storage failure must not prevent app startup. */
  }
}

/** @param {boolean} waiting */
function scheduleRetry(waiting, delay = WAITING_RETRY_MS) {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  if (!waiting) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    // A hidden page retries on `pageshow` / visibility instead.
    if (globalThis.document?.visibilityState === "hidden") return;
    void resumeCheckSubmissions();
  }, delay);
}

let started = false;

export function startCheckSubmissionRecovery() {
  if (started) return;
  started = true;
  const resume = () => {
    void resumeCheckSubmissions();
  };
  window.addEventListener("connectionretry", resume);
  window.addEventListener("online", resume);
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
