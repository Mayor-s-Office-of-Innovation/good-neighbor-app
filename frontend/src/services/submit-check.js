// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  submitCheck — file the in-progress walk against the backend (online cutover).

  The single seam that turns a captured walk into a persisted, analyzed record. The
  mock analyzer + local `checks` persistence are gone (docs/archive/frontend-api-wiring-plan.md):
    1. create the check (client-minted id → `idempotency-key`)
    2. per photo: presign → PUT to S3 → register (each register enqueues the
       artifact's async analysis)
    3. wait for the analyses to land (bounded poll), then complete (folds the
       scorecard + mints tasks)
    4. read the authoritative completed check and adapt its analyses → findings,
       stored on the in-memory session so 5e results renders them.

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
  evaluateAssessment,
  getCheck,
  listTasks,
} from "./api.js";
import {
  analysesToFindings,
  cityCategoriesForCheck,
} from "../domain/check-adapter.js";
import {
  SIDES,
  allItems,
  getCurrentCheck,
  markSubmitted,
} from "../state/check-session.js";

/**
 * Submit the current walk to the backend and hydrate the session with findings.
 * Throws on any backend/network failure (no silent local fallback).
 * @returns {Promise<object|null>} the getCheck detail payload, or null if no walk.
 */
export async function submitCheck() {
  const active = getCurrentCheck();
  if (!active) return null;

  // 1. Start the run. `sides` records which sides were skipped (server stores it);
  //    `siteId` is derived server-side, never sent.
  const sides = SIDES.map((s) => ({
    side: s,
    skipped: !!active.sides[s].skipped,
  }));
  await createCheck(active.id, { sides });

  // 2. Upload every captured photo straight to S3, then register it. Bytes never
  //    transit our API; register enqueues the artifact's async analysis.
  let expectedArtifacts = 0;
  for (const side of SIDES) {
    const sideState = active.sides[side];
    const photos = sideState.items.filter((it) => it.dataUrl);
    const descriptionText = sideState.description?.validated
      ? sideState.description.text
      : "";

    for (const [index, it] of photos.entries()) {
      await uploadArtifact(active.id, {
        side: it.side,
        dataUrl: it.dataUrl,
        capturedAt: it.uploadedAt,
        ...(descriptionText && index === 0 ? { text: descriptionText } : {}),
      });
      expectedArtifacts += 1;
    }

    if (photos.length === 0 && descriptionText) {
      await registerTextArtifact(active.id, {
        side,
        text: descriptionText,
        capturedAt: new Date().toISOString(),
      });
      expectedArtifacts += 1;
    }
  }

  // 3. Let the analyses land (worker → analyzer), then close the run out.
  //    Completion folds artifacts into an assessment; evaluation mints tasks.
  await waitForAnalyses(active.id, { expected: expectedArtifacts });
  const completion = await completeCheck(active.id);
  if (!completion.assessmentReady || !completion.assessment) {
    throw new Error("Check completed without an assessment to evaluate.");
  }
  await evaluateAssessment(completion.assessment);

  // 4. Read the authoritative completed check + analyses and adapt to findings.
  //    assessment evaluation just minted immediately resolvable TASK# items, so fetch them to classify each
  //    finding city-vs-handle from the backend's stamped `type` (no client-side
  //    escalation rule). 5e reads these findings + the session photos.
  const [detail, { tasks }] = await Promise.all([
    getCheck(active.id),
    listTasks({ status: "open" }),
  ]);
  const cityCategories = cityCategoriesForCheck(tasks, active.id);
  markSubmitted(analysesToFindings(detail.analyses, cityCategories));

  // Drop the resumable draft (home won't offer Resume); keep the in-memory session.
  await clearDraft();
  return detail;
}
