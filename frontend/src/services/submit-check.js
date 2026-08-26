// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  submitCheck — file the in-progress walk against the backend (online cutover).

  The single seam that turns a captured walk into a persisted, analyzed record. The
  mock analyzer + local `checks` persistence are gone (docs/archive/frontend-api-wiring-plan.md):
    1. create the check (client-minted id → `idempotency-key`)
    2. per photo: presign → PUT to S3 → register (each register enqueues the
       artifact's async analysis)
    3. wait for the analyses to land (bounded poll), then complete (folds the
       scorecard). Task minting is DEFERRED to the review screen's Continue so a
       dispute can suppress a finding before its task exists.
    4. read the authoritative completed check and adapt its analyses → findings,
       stored (with the assessment envelope) on the in-memory session so the
       results screen renders them and can evaluate on Continue.

  No local fallback: any failure throws so the caller shows an error (offline is
  post-MVP; there is no write queue). The just-submitted photos stay in the session
  for the results evidence strip; only the resumable draft is dropped.
*/
import { clearDraft } from "../db.js";
import {
  createCheck,
  uploadArtifact,
  registerTextArtifact,
  waitForAnalyses,
  completeCheck,
  getCheck,
} from "./api.js";
import { analysesToFindings } from "../domain/check-adapter.js";
import {
  getCurrentCheck,
  markAnalyzing,
  markAnalysisFailed,
  getSideOrder,
  markSubmitted,
} from "../state/check-session.js";
import { startRun, span, mark } from "./instrument.js";

const pendingFinalizations = new Map();

function analysisFailureMessage(err) {
  const body = err?.body;
  if (body?.code === "analyses_pending") {
    return "The AI is taking longer than expected. Please try again soon.";
  }
  return "Couldn’t finish analyzing this submission. Check your connection and try again.";
}

async function finalizeSubmittedCheck(checkId) {
  const last = await waitForAnalyses(checkId);
  const endComplete = span("completeCheck");
  const completion = await completeCheck(checkId);
  endComplete({ grade: completion?.grade, issues: completion?.issueCount });
  if (!completion.assessmentReady || !completion.assessment) {
    throw new Error("Check completed without an assessment to evaluate.");
  }

  const detail = await getCheck(checkId);
  markSubmitted(analysesToFindings(detail.analyses), completion.assessment, {
    checkId,
  });
  mark("submit:done", { expectedArtifacts: last.artifacts.length });
  return detail;
}

export function resumeSubmittedCheck(checkId) {
  if (pendingFinalizations.has(checkId)) {
    return pendingFinalizations.get(checkId);
  }
  const run = finalizeSubmittedCheck(checkId)
    .catch((err) => {
      console.error("finalizeSubmittedCheck failed", err);
      markAnalysisFailed(analysisFailureMessage(err), { checkId });
      throw err;
    })
    .finally(() => {
      pendingFinalizations.delete(checkId);
    });
  pendingFinalizations.set(checkId, run);
  return run;
}

/**
 * Submit the current walk to the backend and hydrate the session with findings.
 * Throws on any backend/network failure before the submission is safely registered.
 * Once registration succeeds, the longer analysis/completion work continues in the
 * background and home shows the pending state.
 * @param {{ submissionKind?: "check" | "problem_report" }} [opts]
 * @returns {Promise<{ checkId: string }|null>}
 */
export async function submitCheck({ submissionKind = "check" } = {}) {
  const active = getCurrentCheck();
  if (!active) return null;

  startRun("submit", { checkId: active.id });
  const sidesInFlow = getSideOrder();

  // 1. Start the run. `sides` records which sides were skipped (server stores it);
  //    `siteId` is derived server-side, never sent.
  const sides = sidesInFlow.map((s) => ({
    side: s,
    skipped: !!active.sides[s].skipped,
  }));
  const endCreate = span("createCheck");
  await createCheck(active.id, { sides });
  endCreate();

  // 2. Upload every captured artifact straight to S3, then register it — all sides
  //    and photos IN PARALLEL. Bytes never transit our API; each register enqueues
  //    that artifact's async analysis, so firing them together also lets the backend
  //    worker's per-batch fan-out start analyzing sooner. Order is irrelevant: the
  //    backend keys every artifact independently and waitForAnalyses matches by id,
  //    not sequence. Any leg's failure rejects the whole submit (no local fallback).
  //    The `+Nms` start stamps in the perf trace should now cluster (overlap), not
  //    climb one upload-latency at a time as the old serial loop did.
  const endUploads = span("uploads");
  const uploads = [];
  for (const side of sidesInFlow) {
    const sideState = active.sides[side];
    const photos = sideState.items.filter((it) => it.dataUrl);
    const descriptionText = sideState.description?.validated
      ? sideState.description.text
      : "";

    photos.forEach((it, index) => {
      uploads.push(
        uploadArtifact(active.id, {
          side: it.side,
          dataUrl: it.dataUrl,
          capturedAt: it.uploadedAt,
          tag: `${it.side}#${index}`,
          // Description text rides on the side's first photo (index 0).
          ...(descriptionText && index === 0 ? { text: descriptionText } : {}),
        }),
      );
    });

    if (photos.length === 0 && descriptionText) {
      uploads.push(
        registerTextArtifact(active.id, {
          side,
          text: descriptionText,
          capturedAt: new Date().toISOString(),
        }),
      );
    }
  }

  const expectedArtifacts = uploads.length;
  await Promise.all(uploads);
  endUploads({ expectedArtifacts });

  // 3. The submission is durable once every artifact is registered, so switch the
  //    session into a pending-analysis state and let the long analyzer/complete
  //    sequence continue in the background while the user returns home.
  markAnalyzing({ submissionKind });
  await clearDraft(active.flowType);
  mark("submit:queued", { expectedArtifacts, checkId: active.id });
  void resumeSubmittedCheck(active.id);
  return { checkId: active.id };
}
