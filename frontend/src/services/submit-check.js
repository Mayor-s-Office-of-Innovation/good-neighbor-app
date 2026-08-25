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
  SIDES,
  getCurrentCheck,
  markSubmitted,
} from "../state/check-session.js";
import { startRun, span, mark } from "./instrument.js";

/**
 * Submit the current walk to the backend and hydrate the session with findings.
 * Throws on any backend/network failure (no silent local fallback).
 * @returns {Promise<object|null>} the getCheck detail payload, or null if no walk.
 */
export async function submitCheck() {
  const active = getCurrentCheck();
  if (!active) return null;

  startRun("submit", { checkId: active.id });

  // 1. Start the run. `sides` records which sides were skipped (server stores it);
  //    `siteId` is derived server-side, never sent.
  const sides = SIDES.map((s) => ({
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
  for (const side of SIDES) {
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

  // 3. Let the analyses land (worker → analyzer), then close the run out.
  //    Completion folds artifacts into the assessment envelope. Task minting is
  //    DEFERRED: evaluateAssessment now runs when the user leaves the review
  //    screen (check-results Continue), so disputes can suppress tasks before
  //    they're created. The assessment rides on the session for that call.
  await waitForAnalyses(active.id, { expected: expectedArtifacts });
  const endComplete = span("completeCheck");
  const completion = await completeCheck(active.id);
  endComplete({ grade: completion?.grade, issues: completion?.issueCount });
  if (!completion.assessmentReady || !completion.assessment) {
    throw new Error("Check completed without an assessment to evaluate.");
  }

  // 4. Read the authoritative completed check + analyses and adapt to findings for
  //    the review screen. No task-based city/handle classification here — no tasks
  //    exist yet (they mint on Continue) and the review screen renders plain cards;
  //    the home hub fetches its own tasks after the user continues.
  const detail = await getCheck(active.id);
  markSubmitted(analysesToFindings(detail.analyses), completion.assessment);

  // Drop the resumable draft (home won't offer Resume); keep the in-memory session.
  await clearDraft();
  mark("submit:done", { expectedArtifacts });
  return detail;
}
