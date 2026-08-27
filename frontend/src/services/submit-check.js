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
import { clearDraft, getDraft } from "../db.js";
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
  markUploading,
  markAnalyzing,
  markAnalysisFailed,
  getSideOrder,
  markSubmitted,
} from "../state/check-session.js";
import { startRun, span, mark } from "./instrument.js";

const pendingFinalizations = new Map();
const pendingSubmissions = new Map();

/**
 * @typedef {object} PlannedArtifact
 * @property {string} kind
 * @property {string} side
 * @property {string} capturedAt
 * @property {string} signature
 * @property {string} [dataUrl]
 * @property {string} [text]
 * @property {string} [tag]
 */

/**
 * Run one submit step and stamp the failing leg onto its error so the message
 * layer can say *which* step broke. The first leg to fail wins (a nested call
 * that already tagged keeps its own, more specific, leg), which matters for the
 * parallel uploads: `Promise.all`'s first rejection carries the real cause.
 * @template T
 * @param {"start"|"upload"|"analyze"|"complete"|"assessment"} leg
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
  assessment: {
    default:
      "This check finished, but its results couldn’t be read. Please try again.",
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

async function finalizeSubmittedCheck(checkId, { expectedArtifacts } = {}) {
  const last = await withLeg("analyze", () =>
    waitForAnalyses(checkId, { expected: expectedArtifacts }),
  );
  const endComplete = span("completeCheck");
  const completion = await withLeg("complete", () => completeCheck(checkId));
  endComplete({ grade: completion?.grade, issues: completion?.issueCount });
  if (!completion.assessmentReady || !completion.assessment) {
    const err = new Error("Check completed without an assessment to evaluate.");
    err.leg = "assessment";
    throw err;
  }

  markSubmitted(analysesToFindings(last.analyses), completion.assessment, {
    checkId,
  });
  mark("submit:done", { expectedArtifacts: last.artifacts.length });
  return last;
}

/**
 * @param {PlannedArtifact} artifact
 * @returns {string}
 */
function artifactSignature(artifact) {
  return [
    artifact.kind,
    artifact.side,
    artifact.capturedAt || "",
    artifact.text || "",
  ].join("::");
}

/**
 * @param {any} check
 * @returns {PlannedArtifact[]}
 */
function plannedArtifactsForCheck(check) {
  const planned = [];
  const submittedAt = check.submittedAt || check.startedAt || new Date().toISOString();
  const sidesInFlow = check.sideOrder || getSideOrder();

  for (const side of sidesInFlow) {
    const sideState = check.sides[side];
    const photos = sideState.items.filter((it) => it.dataUrl);
    const descriptionText = sideState.description?.validated
      ? sideState.description.text
      : "";

    photos.forEach((it, index) => {
      planned.push({
        kind: "photo",
        side: it.side,
        dataUrl: it.dataUrl,
        capturedAt: it.uploadedAt || submittedAt,
        tag: `${it.side}#${index}`,
        ...(descriptionText && index === 0 ? { text: descriptionText } : {}),
        signature: artifactSignature({
          kind: "photo",
          side: it.side,
          capturedAt: it.uploadedAt || submittedAt,
          ...(descriptionText && index === 0 ? { text: descriptionText } : {}),
        }),
      });
    });

    if (photos.length === 0 && descriptionText) {
      planned.push({
        kind: "text",
        side,
        text: descriptionText,
        capturedAt: submittedAt,
        signature: artifactSignature({
          kind: "text",
          side,
          capturedAt: submittedAt,
          text: descriptionText,
        }),
      });
    }
  }

  return planned;
}

/**
 * @param {string} checkId
 * @returns {Promise<Set<string>>}
 */
async function existingArtifactSignatures(checkId) {
  const existing = await getCheck(checkId);
  return new Set(
    (existing.artifacts || []).map((artifact) =>
      artifactSignature({
        kind: artifact.s3Key ? "photo" : "text",
        side: artifact.side,
        capturedAt: artifact.capturedAt,
        text: artifact.text,
      }),
    ),
  );
}

/**
 * @param {string} checkId
 * @param {PlannedArtifact[]} plannedArtifacts
 * @param {{ resume?: boolean }} [opts]
 * @returns {Promise<number>}
 */
async function uploadPlannedArtifacts(
  checkId,
  plannedArtifacts,
  { resume = false } = {},
) {
  const uploaded = resume ? await existingArtifactSignatures(checkId) : new Set();
  const uploads = plannedArtifacts
    .filter((artifact) => !uploaded.has(artifact.signature))
    .map((artifact) =>
      artifact.kind === "text"
        ? registerTextArtifact(checkId, {
            side: artifact.side,
            text: artifact.text,
            capturedAt: artifact.capturedAt,
          })
        : uploadArtifact(checkId, {
            side: artifact.side,
            dataUrl: artifact.dataUrl,
            capturedAt: artifact.capturedAt,
            text: artifact.text,
            tag: artifact.tag,
          }),
    );
  await withLeg("upload", () => Promise.all(uploads));
  return plannedArtifacts.length;
}

function startFinalization(checkId, { expectedArtifacts } = {}) {
  if (pendingFinalizations.has(checkId)) {
    return pendingFinalizations.get(checkId);
  }
  const run = finalizeSubmittedCheck(checkId, { expectedArtifacts })
    .catch((err) => {
      console.error("finalizeSubmittedCheck failed", err);
      markAnalysisFailed(submitErrorMessage(err), { checkId });
      throw err;
    })
    .finally(() => {
      pendingFinalizations.delete(checkId);
    });
  pendingFinalizations.set(checkId, run);
  return run;
}

/**
 * @param {any} check
 * @param {{ submissionKind?: "check" | "problem_report", resume?: boolean }} [opts]
 * @returns {Promise<any>}
 */
async function runSubmittedCheck(
  check,
  { submissionKind = "check", resume = false } = {},
) {
  startRun("submit", { checkId: check.id });
  const plannedArtifacts = plannedArtifactsForCheck(check);

  // 1. Start the run. `sides` records which sides were skipped (server stores it);
  //    `siteId` is derived server-side, never sent.
  const sides = (check.sideOrder || getSideOrder()).map((s) => ({
    side: s,
    skipped: !!check.sides[s].skipped,
  }));
  const endCreate = span("createCheck");
  await withLeg("start", () => createCheck(check.id, { sides }));
  endCreate();

  const endUploads = span("uploads");
  const expectedArtifacts = await uploadPlannedArtifacts(check.id, plannedArtifacts, {
    resume,
  });
  endUploads({ expectedArtifacts });

  // 3. Once every artifact is registered, the submission is durable and the draft
  //    can be dropped. Home then shifts from upload copy to AI-analysis copy.
  markAnalyzing({ submissionKind, expectedArtifacts, checkId: check.id });
  await Promise.all([
    clearDraft({ flowType: check.flowType, checkId: check.id }),
    clearDraft({ checkId: check.id }),
  ]);
  mark("submit:queued", { expectedArtifacts, checkId: check.id });
  return startFinalization(check.id, { expectedArtifacts });
}

export function resumeSubmittedCheck(checkId, { expectedArtifacts } = {}) {
  return startFinalization(checkId, { expectedArtifacts });
}

export async function resumeUploadingCheck(
  checkId,
  { flowType, submissionKind = "check" } = {},
) {
  if (pendingSubmissions.has(checkId) || pendingFinalizations.has(checkId)) {
    return pendingSubmissions.get(checkId) || pendingFinalizations.get(checkId);
  }

  const draft = await getDraft(flowType);
  if (!draft || draft.id !== checkId) {
    const err = new Error("No matching draft found for upload resume.");
    err.leg = "upload";
    markAnalysisFailed(submitErrorMessage(err), { checkId });
    throw err;
  }

  const run = runSubmittedCheck(draft, { submissionKind, resume: true })
    .catch((err) => {
      console.error("resumeUploadingCheck failed", err);
      markAnalysisFailed(submitErrorMessage(err), { checkId });
      throw err;
    })
    .finally(() => {
      pendingSubmissions.delete(checkId);
    });
  pendingSubmissions.set(checkId, run);
  return run;
}

export function resumeSubmittedCheckInBackground(checkId, opts) {
  void resumeSubmittedCheck(checkId, opts).catch(() => {});
}

export function resumeUploadingCheckInBackground(checkId, opts) {
  void resumeUploadingCheck(checkId, opts).catch(() => {});
}

/**
 * Submit the current walk and immediately switch the UI to the home-screen pending
 * tile. The full create/upload/analyze pipeline continues in the background.
 * @param {{ submissionKind?: "check" | "problem_report" }} [opts]
 * @returns {{ checkId: string }|null}
 */
export function submitCheck({ submissionKind = "check" } = {}) {
  const active = getCurrentCheck();
  if (!active) return null;

  if (pendingSubmissions.has(active.id) || pendingFinalizations.has(active.id)) {
    return { checkId: active.id };
  }

  markUploading({ submissionKind, checkId: active.id });
  const run = runSubmittedCheck(active, { submissionKind })
    .catch((err) => {
      console.error("runSubmittedCheck failed", err);
      if (err?.leg === "start" || err?.leg === "upload") {
        markAnalysisFailed(submitErrorMessage(err), { checkId: active.id });
      }
      throw err;
    })
    .finally(() => {
      pendingSubmissions.delete(active.id);
    });
  pendingSubmissions.set(active.id, run);
  void run.catch(() => {});
  return { checkId: active.id };
}
