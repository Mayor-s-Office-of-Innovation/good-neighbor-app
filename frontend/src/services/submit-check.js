import { connectionAvailable, failedRecovery } from "./evidence-recovery.js";
import {
  getCheck as getHeldCheck,
  getCurrentCheck,
  updateCheckRecovery,
  markScorecardDone,
  clearSubmittedSession,
} from "../state/check-session.js";
// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
import { showInlineError } from "../components/error-notice.js";
/*
  submit-check — background run-level scorecard finalization.

  Guidance is minted per evidence item at capture time (photo-analysis.js
  evaluateAssessment), so the only work left for Done is folding the run's
  per-artifact analyses into one header scorecard:
    1. wait for every registered artifact's analysis to land (bounded poll)
    2. complete the check (backend synthesizes + persists the scorecard)

  Any failure throws. The finished check stays on the device, so
  services/check-submissions.js (and home on load) re-kick the finalization
  idempotently until the completed header lands.
*/
import { waitForAnalyses, completeCheck } from "./api.js";
import { checkItems, itemHasLiveEvidence } from "../domain/check-completion.js";
import { startRun, span, mark } from "./instrument.js";
import { t } from "../i18n/i18n.js";

const pendingScorecardFinalizations = new Map();
const saveNotices = new Map();

/**
 * Run one submit step and stamp the failing leg onto its error so the message
 * layer can say *which* step broke. The first leg to fail wins (a nested call
 * that already tagged keeps its own, more specific, leg), which matters for the
 * parallel uploads: `Promise.all`'s first rejection carries the real cause.
 * @template T
 * @param {"start"|"upload"|"analyze"|"complete"} leg
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withLeg(leg, work) {
  try {
    return await work();
  } catch (err) {
    if (err && typeof err === "object" && err.leg === undefined) err.leg = leg;
    throw err;
  }
}

/**
 * Reduce an error to one cause bucket. Order matters: the analyses-timeout error
 * carries status 0 (it never made an HTTP round-trip) but is a "still working",
 * NOT a connection failure, so `analyses_pending` is checked before status 0.
 * @param {any} err
 * @returns {"pending"|"network"|"conflict"|"too_large"|"rejected"|"server"}
 */
function causeOf(err) {
  if (err?.body?.code === "analyses_pending") return "pending";
  const status = err?.status;
  if (!status) return "network"; // 0 or undefined = transport failure / no round-trip
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status >= 400 && status < 500) return "rejected";
  return "server";
}

/**
 * Per-leg cause → catalog key of the user message. Each leg has a `default` for
 * causes it doesn't spell out; an untagged error falls back to a single generic
 * line. Every message names both the step that failed and what to do next, so
 * no two failure modes read the same. Keys (not text) are stored so the message
 * resolves in the active language at the moment it is shown.
 */
const SUBMIT_MESSAGES = {
  start: {
    network: "error.submit.start.network",
    conflict: "error.submit.start.conflict",
    rejected: "error.submit.start.rejected",
    default: "error.submit.start.default",
  },
  upload: {
    network: "error.submit.upload.network",
    too_large: "error.submit.upload.tooLarge",
    conflict: "error.submit.upload.conflict",
    rejected: "error.submit.upload.rejected",
    default: "error.submit.upload.default",
  },
  analyze: {
    pending: "error.submit.analyze.pending",
    network: "error.submit.analyze.network",
    default: "error.submit.analyze.default",
  },
  complete: {
    network: "error.submit.complete.network",
    default: "error.submit.complete.default",
  },
};

/**
 * Map a submit/analysis failure to a unique, actionable message keyed on the
 * failing leg (stamped by `withLeg`) and the cause bucket. Used by both the
 * foreground submit screens and the background "AI analysis paused" home tile so
 * there is a single source of truth for these strings.
 * @param {any} err
 * @returns {string}
 */
export function submitErrorMessage(err) {
  const leg = SUBMIT_MESSAGES[err?.leg];
  if (!leg) return t("error.submit.generic");
  return t(leg[causeOf(err)] ?? leg.default);
}

async function finalizeCaptureScorecard(
  checkId,
  { expectedArtifacts = undefined, originSiteId = undefined } = {},
) {
  startRun("captureScorecard", { checkId });
  const endAnalyze = span("captureScorecard:wait", {
    expected: expectedArtifacts,
  });
  const last = await withLeg("analyze", () =>
    waitForAnalyses(checkId, {
      expected: expectedArtifacts,
      ...(originSiteId ? { originSiteId } : {}),
    }),
  );
  endAnalyze({
    analyzed: last.analyses.length,
    artifacts: last.artifacts.length,
  });

  const endComplete = span("captureScorecard:completeCheck");
  const completion = await withLeg("complete", () =>
    originSiteId
      ? completeCheck(checkId, { originSiteId })
      : completeCheck(checkId),
  );
  endComplete({ grade: completion?.grade, issues: completion?.issueCount });
  mark("captureScorecard:done", {
    expectedArtifacts: last.artifacts.length,
    checkId,
  });
  return completion;
}

/**
 * Count the evidence items already captured for this check. This is used only as
 * the coverage target for background run-level scorecard finalization; it does
 * not register or analyze anything on Done.
 *
 * Dead items don't count: a permanently failed item with no registered
 * artifactId can never produce a backend artifact, so expecting it would leave
 * waitForAnalyses waiting for an ART# row that will never exist (180s timeout,
 * then the finalization re-kicks into the same wall on every home load). The
 * live-item rule is shared with the completion gate (check-completion.js), so
 * Finish enabling and the coverage target always describe the same set.
 * @param {any} check
 * @returns {number}
 */
export function expectedArtifactCountForCheck(check) {
  return checkItems(check).filter((item) => itemHasLiveEvidence(item)).length;
}

function showSaveRecovery(checkId, expectedArtifacts, target = null) {
  // Expired notices stay quiet through rerenders, but returning to Home gives
  // a deliberately paused finalization its existing Retry action again.
  const noticeTarget =
    target ||
    (typeof document !== "undefined"
      ? document.querySelector("#view > *")
      : null);
  const previous = saveNotices.get(checkId);
  if (previous?.target === noticeTarget && noticeTarget?.isConnected) return;
  previous?.close();
  saveNotices.set(checkId, {
    close: () => {},
    target: noticeTarget,
    ...showInlineError(t("notice.saveFailed"), {
      key: `check-save:${checkId}`,
      duration: 5000,
      target: noticeTarget,
      warning: true,
      retryLabel: t("notice.retrySaving"),
      retryAvailable: () => connectionAvailable(),
      retry: () =>
        finalizeCaptureScorecardInBackground(checkId, {
          expectedArtifacts,
          manual: true,
        }),
    }),
  });
}

/** Reattach durable failures after Home replaces its contents. */
export function restoreFinalizationNotices(check, target) {
  const ids = new Set([
    ...saveNotices.keys(),
    ...(check?.id ? [check.id] : []),
  ]);
  for (const id of ids) {
    const held = getHeldCheck(id) || (check?.id === id ? check : null);
    if (held?.finalizationRecovery?.state === "manual")
      showSaveRecovery(id, held.expectedArtifacts, target);
  }
}

export function finalizeCaptureScorecardInBackground(
  checkId,
  { expectedArtifacts = undefined, manual = false } = {},
) {
  const check =
    getHeldCheck(checkId) ||
    (getCurrentCheck()?.id === checkId ? getCurrentCheck() : null);
  // Recovery/removal can change the live set after Finish. The backend still
  // verifies every registered artifact, so use the current local coverage target.
  if (check?.status === "capture-complete")
    expectedArtifacts = expectedArtifactCountForCheck(check);
  if (checkItems(check).some((item) => item.deletionPending)) return null;
  if (check?.status === "capture-complete" && expectedArtifacts === 0) {
    // There is nothing to synthesize. Keep failed local cards available for
    // deletion, but do not create an empty, misleadingly clear scorecard.
    return (async () => {
      await updateCheckRecovery(checkId, undefined);
      markScorecardDone(checkId);
      saveNotices.get(checkId)?.close();
      saveNotices.delete(checkId);
      if (checkItems(check).length === 0) await clearSubmittedSession(checkId);
      return null;
    })();
  }
  const recovery = check?.finalizationRecovery;
  if (recovery?.state === "manual")
    showSaveRecovery(checkId, expectedArtifacts);
  if (!connectionAvailable()) return null;
  if (
    check &&
    checkItems(check).some(
      (item) =>
        itemHasLiveEvidence(item) &&
        item.analysis?.status !== "analyzed" &&
        item.analysis?.recovery?.state !== "blocked",
    )
  )
    return null;
  if (
    !manual &&
    (["manual", "blocked"].includes(recovery?.state) ||
      recovery?.nextAttemptAt > Date.now())
  )
    return null;
  if (!checkId || expectedArtifacts === 0) return null;
  if (pendingScorecardFinalizations.has(checkId)) {
    return pendingScorecardFinalizations.get(checkId);
  }
  if (manual && recovery?.state !== "manual") return null;
  saveNotices.get(checkId)?.close();
  saveNotices.delete(checkId);
  if (manual)
    saveNotices.set(
      checkId,
      showInlineError(t("common.retrying"), {
        key: `check-save:${checkId}`,
        duration: 5000,
        warning: true,
      }),
    );
  const run = Promise.resolve()
    .then(async () => {
      await updateCheckRecovery(checkId, {
        ...recovery,
        ...(manual ? { attempts: 0 } : {}),
        state: "working",
        nextAttemptAt: undefined,
      });
      return finalizeCaptureScorecard(checkId, {
        expectedArtifacts,
        originSiteId: check?.siteId,
      });
    })
    .then(async (result) => {
      await updateCheckRecovery(checkId, undefined);
      saveNotices.get(checkId)?.close();
      saveNotices.delete(checkId);
      return result;
    })
    .catch(async (err) => {
      const previous = manual ? { ...recovery, attempts: 0 } : recovery;
      const next =
        err?.name === "AbortError" ||
        err?.name === "SiteBindingChangedError" ||
        !connectionAvailable() ||
        causeOf(err) === "network"
          ? { ...previous, state: "waiting" }
          : causeOf(err) === "pending"
            ? {
                ...previous,
                state: "scheduled",
                nextAttemptAt: Date.now() + 15_000,
              }
            : failedRecovery(previous, "complete", err);
      await updateCheckRecovery(checkId, next);
      saveNotices.get(checkId)?.close();
      saveNotices.delete(checkId);
      if (next.state === "manual") showSaveRecovery(checkId, expectedArtifacts);
      throw err;
    })
    .finally(() => {
      pendingScorecardFinalizations.delete(checkId);
    });
  pendingScorecardFinalizations.set(checkId, run);
  void run.catch(() => {});
  return run;
}
