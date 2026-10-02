// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  submit-check — background run-level scorecard finalization.

  Guidance is minted per evidence item at capture time (photo-analysis.js
  evaluateAssessment), so the only work left for Done is folding the run's
  per-artifact analyses into one header scorecard:
    1. wait for every registered artifact's analysis to land (bounded poll)
    2. complete the check (backend synthesizes + persists the scorecard)

  No local fallback: any failure throws (offline is post-MVP; there is no write
  queue). The capture-complete session persists the checkId, so home re-kicks the
  finalization idempotently on every load until the completed header lands.
*/
import { waitForAnalyses, completeCheck } from "./api.js";
import { checkItems, itemHasLiveEvidence } from "../domain/check-completion.js";
import { startRun, span, mark } from "./instrument.js";
import { t } from "../i18n/i18n.js";

const pendingScorecardFinalizations = new Map();

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

async function finalizeCaptureScorecard(checkId, { expectedArtifacts } = {}) {
  startRun("captureScorecard", { checkId });
  const endAnalyze = span("captureScorecard:wait", {
    expected: expectedArtifacts,
  });
  const last = await withLeg("analyze", () =>
    waitForAnalyses(checkId, { expected: expectedArtifacts }),
  );
  endAnalyze({
    analyzed: last.analyses.length,
    artifacts: last.artifacts.length,
  });

  const endComplete = span("captureScorecard:completeCheck");
  const completion = await withLeg("complete", () => completeCheck(checkId));
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

export function finalizeCaptureScorecardInBackground(
  checkId,
  { expectedArtifacts } = {},
) {
  if (!checkId || expectedArtifacts === 0) return null;
  if (pendingScorecardFinalizations.has(checkId)) {
    return pendingScorecardFinalizations.get(checkId);
  }
  const run = finalizeCaptureScorecard(checkId, { expectedArtifacts })
    .catch((err) => {
      console.error("finalizeCaptureScorecard failed", err);
      throw err;
    })
    .finally(() => {
      pendingScorecardFinalizations.delete(checkId);
    });
  pendingScorecardFinalizations.set(checkId, run);
  void run.catch(() => {});
  return run;
}
