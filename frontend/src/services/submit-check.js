// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  submitCheck — file the in-progress walk against the backend (online cutover).

  The single seam that turns a captured walk into a persisted, analyzed record. The
  mock analyzer + local `checks` persistence are gone (docs/frontend-api-wiring-plan.md):
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
  waitForAnalyses,
  completeCheck,
  getCheck,
} from "./api.js";
import { analysesToFindings } from "../domain/check-adapter.js";
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
  const photos = allItems().filter((it) => it.dataUrl);
  for (const it of photos) {
    await uploadArtifact(active.id, {
      side: it.side,
      dataUrl: it.dataUrl,
      capturedAt: it.uploadedAt,
    });
  }

  // 3. Let the analyses land (worker → analyzer), then close the run out —
  //    complete folds the analyzed artifacts into one scorecard and mints tasks.
  await waitForAnalyses(active.id, { expected: photos.length });
  await completeCheck(active.id);

  // 4. Read the authoritative completed check + analyses and adapt to findings.
  //    5e reads these findings + the session photos, then clears the session.
  const detail = await getCheck(active.id);
  markSubmitted(analysesToFindings(detail.analyses));

  // Drop the resumable draft (home won't offer Resume); keep the in-memory session.
  await clearDraft();
  return detail;
}
