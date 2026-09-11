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
import { startRun, span, mark } from "./instrument.js";

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
 * Per-leg cause → user message. Each leg has a `default` for causes it doesn't
 * spell out; an untagged error falls back to a single generic line. Every string
 * names both the step that failed and what to do next, so no two failure modes
 * read the same.
 */
const SUBMIT_MESSAGES = {
  start: {
    network:
      "Couldn’t start this check — we couldn’t reach the server. Check your connection and try again.",
    conflict:
      "This check may already have been filed. Go home to check before submitting again.",
    rejected:
      "The server wouldn’t accept this check. Please try again; if it keeps happening, report it.",
    default:
      "Something went wrong on our end starting this check. Please try again in a moment.",
  },
  upload: {
    network:
      "Couldn’t upload your photos — we couldn’t reach the server. Check your connection and try again.",
    too_large:
      "One of your photos was too large to upload. Retake it and try again.",
    conflict:
      "One of your photos looks already uploaded. Go home to check, or try again.",
    rejected:
      "The server rejected one of your photos. Please try again; if it keeps happening, report it.",
    default:
      "Something went wrong on our end uploading your photos. Please try again in a moment.",
  },
  analyze: {
    pending: "The AI is taking longer than expected. Please try again soon.",
    network:
      "Lost connection while waiting for the AI analysis. Check your connection and reopen this check.",
    default: "The analysis service had a problem. Please try again soon.",
  },
  complete: {
    network:
      "Couldn’t finish filing this check — the connection dropped. Reopen it to finish.",
    default:
      "Something went wrong finishing this check. Please try again soon.",
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
  if (!leg) {
    return "Couldn’t file this check. Check your connection and try again.";
  }
  return leg[causeOf(err)] ?? leg.default;
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
 * @param {any} check
 * @returns {number}
 */
export function expectedArtifactCountForCheck(check) {
  if (!check?.places) return 0;
  return (check.placeOrder || Object.keys(check.places)).reduce(
    (count, placeId) => {
      const items = Array.isArray(check.places[placeId]?.items)
        ? check.places[placeId].items
        : [];
      return (
        count +
        items.filter(
          (item) =>
            item?.kind === "text" ||
            item?.dataUrl ||
            item?.upload?.artifactId ||
            item?.analysis?.artifactId,
        ).length
      );
    },
    0,
  );
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
