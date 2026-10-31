import {
  connectionAvailable,
  removingEvidence,
  canManuallyRetry,
  failedRecovery,
  withUploadSlot,
} from "./evidence-recovery.js";
// @ts-nocheck -- matches the surrounding frontend migration baseline.
import {
  getSite,
  deleteCapturePhoto,
  releaseCaptureOriginal,
  getCaptureMedia,
  saveDraft,
  saveFinishedCheck,
} from "../db.js";
import { observePhotoStage, photoAttemptId } from "./photo-telemetry.js";
import { pollCheck } from "./check-polling.js";
import { watchDuplicateIssues } from "./duplicate-issues.js";
import { projectDuplicateTasks } from "../domain/duplicate-issues.js";
/*
  photo-analysis — incremental evidence pipeline for perimeter checks.

  The perimeter walk is now a capture container; each photo or typed description
  is its own analysis unit. This service creates the backend check header
  idempotently, registers one artifact, waits for that artifact's ANALYSIS# item,
  evaluates that item through the guidance rulebase, and mirrors the result onto
  the local check session.
*/
import {
  createCheck,
  deleteArtifact,
  evaluateAssessment,
  getAssessmentGuidance,
  getCheck,
  registerArtifact,
  submitConditionAnswers,
  uploadArtifact,
  registerTextArtifact,
  updateArtifactLocation,
  ApiError,
  contentTypeFromDataUrl,
  dataUrlToBlob,
  LEG,
} from "./api.js";
import { readCaptureDeviceLocation } from "./device-location.js";
import {
  addItem,
  findCheckForItem,
  getCheck as getHeldCheck,
  getCurrentCheck,
  removeItem,
  updateItem,
  updateItemAnalysis,
} from "../state/check-session.js";

const POLL_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 2000;

// What every artifact sends the analyzer as `position_descriptor` (ADR 0014):
// the check has no per-photo position, and nothing downstream decides on the
// value, so it is a fixed literal that matches the worker's.
const POSITION_DESCRIPTOR = "perimeter";

/**
 * One evidence item of a session check, or null.
 * @param {any} check
 * @param {string} itemId
 */
function sessionItem(check, itemId) {
  return check?.items?.find((candidate) => candidate.id === itemId) || null;
}

/**
 * The in-memory check holding an item: the one on screen, else a finished
 * check still uploading in the background (services/check-submissions.js).
 * @param {string} itemId
 */
function checkWithItem(itemId) {
  const current = getCurrentCheck();
  if (sessionItem(current, itemId)) return current;
  return findCheckForItem(itemId);
}

/** @param {string} itemId */
function itemById(itemId) {
  return sessionItem(checkWithItem(itemId), itemId);
}

/** Is this check still held (on screen or finished), so its results still apply? */
function isHeld(check) {
  return getCurrentCheck()?.id === check.id || Boolean(getHeldCheck(check.id));
}

/**
 * One human-readable progress stage the card shows as it happens:
 *   uploaded — media bytes reached S3 (or text registered)
 *   sent     — the artifact is registered and the analyzer is working on it
 *   waiting  — polling for the result (shown with a live elapsed timer)
 * Stamps persist per stage (ISO timestamps) so a card can show how long each
 * step took and, after a failure, how long we waited overall.
 * @typedef {{ uploaded?: string, sent?: string, waiting?: string }} AnalysisStages
 */

async function confirmLocalSave(check) {
  if (!check || !isHeld(check)) return false;
  try {
    if (check?.status === "in-progress") await saveDraft(check);
    else await saveFinishedCheck(check);
    return true;
  } catch {
    return false;
  }
}

const active = new Set();
const duplicateWatches = new Map();
function checkDuplicates(itemId, tasks, analysisId) {
  if (typeof document === "undefined") return;
  duplicateWatches.get(itemId)?.();
  for (const [id, cancel] of duplicateWatches)
    if (!itemById(id)) {
      cancel();
      duplicateWatches.delete(id);
    }
  const assessmentId = itemById(itemId)?.analysis?.assessment?.assessmentId;
  let pendingLinks = null;
  const publish = () => {
    const current = itemById(itemId);
    if (
      !current ||
      current.analysis?.sourceAnalysis?.analysisId !== analysisId ||
      current.analysis?.assessment?.assessmentId !== assessmentId
    ) {
      cancel();
      duplicateWatches.delete(itemId);
      return;
    }
    if (!pendingLinks || document.querySelector("dialog[open]")) return;
    const projected = projectDuplicateTasks(tasks, pendingLinks);
    pendingLinks = null;
    updateItemAnalysis(itemId, {
      tasks: tasks.map(
        (task) =>
          projected.find((t) => t.taskId === task.taskId) || {
            ...task,
            duplicateHidden: true,
          },
      ),
    });
  };
  const stop = watchDuplicateIssues(
    tasks.map((task) => task.taskId),
    (links) => {
      pendingLinks = links;
      publish();
    },
  );
  const cancel = () => {
    stop();
    document.removeEventListener("close", publish, true);
  };
  document.addEventListener("close", publish, true);
  duplicateWatches.set(itemId, cancel);
}

/**
 * @typedef {object} AnswerAnalysisQuestionResult
 * @property {Record<string, unknown>} [assessmentItem] Updated guidance assessment.
 * @property {Record<string, unknown>} [conditionItem] Updated answered condition.
 * @property {Record<string, unknown> | null} [taskItem] Task created for the answer, when applicable.
 * @property {Record<string, unknown> | null} [evaluation] Rulebase evaluation returned by the backend.
 */

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Stamp `err.leg` (first leg wins — a nested call's more specific tag keeps
 * its own) so failure records name the step that broke. Same convention as
 * services/submit-check.js `withLeg`.
 * @template T
 * @param {string} leg
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withLeg(leg, work) {
  try {
    return await work();
  } catch (err) {
    if (err && typeof err === "object" && err.leg === undefined) {
      err.leg = leg;
    }
    throw err;
  }
}

/** Reconcile terminal local cards using reads only; never enqueue a new generation. */
export async function reconcileFailedEvidence(check) {
  const candidates = (check.items || []).filter(
    (item) =>
      !item.deletionPending &&
      item.analysis?.status === "failed" &&
      item.analysis?.failure?.leg === "analyze" &&
      item.analysis?.artifactId &&
      !active.has(item.id),
  );
  if (!candidates.length || !connectionAvailable()) return;
  const detail = await getCheck(check.id, { originSiteId: check.siteId });
  if (!isHeld(check) || (await getSite())?.siteId !== check.siteId) return;
  for (const item of candidates) {
    if (active.has(item.id) || item.analysis?.status !== "failed") continue;
    const artifact = (detail.artifacts || []).find(
      (entry) => entry.artifactId === item.analysis.artifactId,
    );
    const analysis = (detail.analyses || []).find(
      (entry) =>
        entry.artifactId === item.analysis.artifactId &&
        entry.status === "analyzed" &&
        (!artifact?.analysisGeneration ||
          entry.analysisGeneration === artifact.analysisGeneration),
    );
    if (!analysis) {
      const failed = (detail.analyses || []).find(
        (entry) =>
          entry.artifactId === item.analysis.artifactId &&
          entry.status === "failed" &&
          (!artifact?.analysisGeneration ||
            entry.analysisGeneration === artifact.analysisGeneration),
      );
      if (
        failed?.error?.code &&
        failed.error.code !== item.analysis.failure?.code
      )
        updateItemAnalysis(item.id, {
          failure: { ...item.analysis.failure, code: failed.error.code },
        });
      continue;
    }
    updateItemAnalysis(item.id, {
      sourceAnalysis: analysis,
      serverGeneration: undefined,
      restartRequestId: undefined,
      recovery: { stage: "evaluate", state: "scheduled", attempts: 0 },
    });
    analyzeEvidenceItem(item.id);
  }
}

async function ensureRemoteCheck(check) {
  if (check.remoteStarted) return;
  await createCheck(
    check.id,
    { flowType: check.flowType },
    { originSiteId: check.siteId },
  );
  check.remoteStarted = true;
}

async function waitForArtifactAnalysis(
  checkId,
  artifactId,
  {
    timeoutMs = POLL_TIMEOUT_MS,
    intervalMs = POLL_INTERVAL_MS,
    originSiteId = undefined,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  return pollCheck(
    checkId,
    getCheck,
    (last) => {
      const analysis = (last.analyses || []).find(
        (item) => item.artifactId === artifactId,
      );
      const artifact = (last.artifacts || []).find(
        (candidate) => candidate.artifactId === artifactId,
      );
      if (
        analysis &&
        (!artifact?.analysisGeneration ||
          analysis.analysisGeneration === artifact.analysisGeneration)
      )
        return analysis;
      if (Date.now() >= deadline) {
        throw new ApiError(`Analysis still processing for ${artifactId}`, {
          body: { code: "analyses_pending", artifactId },
        });
      }
      return undefined;
    },
    { intervalMs, originSiteId },
  );
}

function conditionId(artifactId, concern, index) {
  if (typeof concern.conditionId === "string" && concern.conditionId) {
    return concern.conditionId;
  }
  if (typeof concern.condition_id === "string" && concern.condition_id) {
    return concern.condition_id;
  }
  return `${artifactId}-${String(index + 1).padStart(3, "0")}-${slugify(
    concern.category,
  )}`;
}

function assessmentFromAnalysis({ checkId, artifactId, analysis }) {
  const analyzedAt = analysis.analyzedAt || new Date().toISOString();
  const concerns = Array.isArray(analysis.concerns) ? analysis.concerns : [];
  return {
    assessmentId: `${checkId}-${artifactId}`,
    checkId,
    reportedAt: analyzedAt,
    rubricVersion: analysis.rubricVersion,
    grade: analysis.grade || null,
    conditions: concerns
      .filter((concern) => (concern.rating || 0) > 0)
      .map((concern, index) => ({
        conditionId: conditionId(artifactId, concern, index),
        category: concern.category,
        severity: concern.rating,
        severityLabel: concern.ratingLabel,
        userFriendlyLabel: concern.userFriendlyLabel,
        description: concern.explanation || "",
        translations: concern.translations,
        sourceArtifactIds: [artifactId],
        evidenceIndices: concern.evidenceIndices || [],
      })),
    ...(hasCoordinates(analysis)
      ? {
          assessment: {
            metadata: {
              position_descriptor: POSITION_DESCRIPTOR,
              reported_at: analysis.capturedAt || analyzedAt,
              latitude: analysis.latitude,
              longitude: analysis.longitude,
            },
          },
        }
      : {}),
    rawAssessment: {
      checkId,
      artifactId,
      analyzedAt,
      grade: analysis.grade,
      summary: analysis.gradeDescription,
      rubricVersion: analysis.rubricVersion,
      concerns,
    },
  };
}

// 0,0 is the analyzer's placeholder for a photo without device location.
function hasCoordinates(value) {
  return (
    !(value?.latitude === 0 && value?.longitude === 0) &&
    Number.isFinite(value?.latitude) &&
    Number.isFinite(value?.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

// A location that arrived after upload still belongs on the photo's tasks.
function withLocation(analysis, location) {
  return hasCoordinates(analysis) || !hasCoordinates(location)
    ? analysis
    : {
        ...analysis,
        latitude: location.latitude,
        longitude: location.longitude,
      };
}

// An expired session, rejected token, timeout or throttling can pass later.
const RETRIED_LOCATION_STATUSES = new Set([401, 403, 408, 429]);
// A server that keeps failing gets this long; time offline doesn't count.
const LOCATION_RETRY_MS = 10 * 60_000;
/** @type {Set<string>} */
const locationSendsInFlight = new Set();

/**
 * @param {string | null} itemId
 * @param {string} checkId
 * @param {string} artifactId
 * @param {{ latitude: number, longitude: number, accuracyMeters?: number }} location
 * @returns {Promise<boolean>} false while a retry is still due
 */
async function sendLocation(itemId, checkId, artifactId, location) {
  // A GPS fix arriving during a recovery retry would send twice.
  if (locationSendsInFlight.has(artifactId)) return false;
  locationSendsInFlight.add(artifactId);
  let settled = true;
  try {
    await updateArtifactLocation(checkId, artifactId, location);
  } catch (err) {
    console.warn("Could not send the photo's location", err?.status);
    // check-submissions.js retries these; any other answer won't change.
    if (isConnectionFailure(err)) {
      settled = false;
      // The server-error clock restarts once the phone is back online.
      const item = itemId ? itemById(itemId) : null;
      if (item?.locationRetryUntil)
        updateItem(item.id, { locationRetryUntil: undefined });
    } else if (
      err?.status >= 500 ||
      RETRIED_LOCATION_STATUSES.has(err?.status)
    ) {
      const item = itemId ? itemById(itemId) : null;
      // Saved on the item so a reload doesn't restart the clock.
      const until = item?.locationRetryUntil ?? Date.now() + LOCATION_RETRY_MS;
      if (item && !item.locationRetryUntil)
        updateItem(item.id, { locationRetryUntil: until });
      settled = Date.now() >= until;
    }
  } finally {
    locationSendsInFlight.delete(artifactId);
  }
  if (settled && itemId) updateItem(itemId, { locationUnsent: false });
  return settled;
}

/**
 * A late GPS fix the server hasn't confirmed yet.
 * @param {any} item
 */
export function hasUnsentLocation(item) {
  return Boolean(
    item?.locationUnsent &&
      hasCoordinates(item.location) &&
      (item.analysis?.artifactId || item.upload?.artifactId),
  );
}

/**
 * @param {string} checkId
 * @param {any} item
 * @returns {Promise<boolean>}
 */
export function resendItemLocation(checkId, item) {
  return sendLocation(
    item.id,
    checkId,
    item.analysis?.artifactId || item.upload?.artifactId,
    item.location,
  );
}

async function guidanceFromAnalysis(
  checkId,
  artifactId,
  analysis,
  originSiteId = undefined,
) {
  const assessment = assessmentFromAnalysis({ checkId, artifactId, analysis });
  const guidance = originSiteId
    ? await evaluateAssessment(assessment, { originSiteId })
    : await evaluateAssessment(assessment);
  return { analysis, assessment, guidance };
}

function concernsFromAssessment(assessment) {
  const conditions = Array.isArray(assessment?.identified_conditions_of_concern)
    ? assessment.identified_conditions_of_concern
    : [];
  return conditions.map((condition) => ({
    conditionId:
      typeof condition.condition_id === "string"
        ? condition.condition_id
        : undefined,
    category: condition.category,
    rating: condition.severity,
    ratingLabel: condition.severity_label,
    userFriendlyLabel: condition.user_friendly_label,
    explanation: condition.description || "",
    ...(condition.translations ? { translations: condition.translations } : {}),
    evidenceIndices: condition.evidence_indices || [],
  }));
}

function assessmentFromRefreshedAnalysis({
  checkId,
  artifactId,
  analysisId,
  assessment,
  location,
}) {
  const analyzedAt = new Date().toISOString();
  const concerns = concernsFromAssessment(assessment);
  const revision = analyzedAt.replace(/[^0-9]/g, "");
  const resolvedLocation = hasCoordinates(location)
    ? location
    : hasCoordinates(assessment?.metadata)
      ? {
          latitude: assessment.metadata.latitude,
          longitude: assessment.metadata.longitude,
        }
      : null;
  return {
    assessmentId: `${checkId}-${artifactId}-${revision}`,
    checkId,
    reportedAt:
      assessment?.metadata?.reported_at || assessment?.created_at || analyzedAt,
    rubricVersion: undefined,
    grade: assessment?.general_conditions?.label || null,
    ...(hasCoordinates(resolvedLocation)
      ? {
          assessment: {
            metadata: {
              ...assessment?.metadata,
              latitude: resolvedLocation.latitude,
              longitude: resolvedLocation.longitude,
            },
          },
        }
      : {}),
    conditions: concerns
      .filter((concern) => (concern.rating || 0) > 0)
      .map((concern, index) => ({
        conditionId: conditionId(artifactId, concern, index),
        category: concern.category,
        severity: concern.rating,
        severityLabel: concern.ratingLabel,
        userFriendlyLabel: concern.userFriendlyLabel,
        description: concern.explanation || "",
        ...(concern.translations ? { translations: concern.translations } : {}),
        sourceArtifactIds: [artifactId],
        evidenceIndices: concern.evidenceIndices || [],
      })),
    rawAssessment: {
      analysisId,
      checkId,
      artifactId,
      analyzedAt,
      grade: assessment?.general_conditions?.label,
      summary: assessment?.general_conditions?.description,
      assessment,
      concerns,
    },
  };
}

async function evaluateArtifact(checkId, itemId, artifactId) {
  const telemetry = {
    check_id: checkId,
    artifact_id: artifactId,
    attempt_id: photoAttemptId(),
  };
  updateItemAnalysis(itemId, {
    status: "analyzing",
    artifactId,
    // Merge onto the existing stages — a full object here would discard the
    // earlier `uploaded` stamp (updateItemAnalysis merges shallowly).
    stages: {
      ...(itemById(itemId)?.analysis?.stages || {}),
      sent: new Date().toISOString(),
    },
  });
  const analysis =
    itemById(itemId)?.analysis?.sourceAnalysis ||
    (await withLeg("analyze", () =>
      observePhotoStage("analyze", telemetry, () =>
        waitForArtifactAnalysis(checkId, artifactId, {
          originSiteId: checkWithItem(itemId)?.siteId,
        }),
      ),
    ));
  if (analysis.status && analysis.status !== "analyzed") {
    updateItemAnalysis(itemId, {
      status: "failed",
      artifactId,
      lastTriedAt: new Date().toISOString(),
      recovery: {
        stage: "analyze",
        state: analysis.retryable === true ? "manual" : "blocked",
        attempts: 0,
      },
      serverGeneration: analysis.analysisGeneration || artifactId,
      error: analysis.error?.message || "Analysis failed.",
      failure: {
        leg: "analyze",
        uploaded: true,
        enqueued: true,
        backendError: true,
        code: analysis.error?.code,
      },
    });
    return;
  }

  const recovery = itemById(itemId)?.analysis?.recovery;
  updateItemAnalysis(itemId, {
    sourceAnalysis: analysis,
    recovery: {
      stage: "evaluate",
      state: "working",
      attempts: recovery?.stage === "evaluate" ? recovery.attempts || 0 : 0,
    },
  });
  const { assessment, guidance } = await withLeg("evaluate", () =>
    observePhotoStage("evaluate", telemetry, () =>
      guidanceFromAnalysis(
        checkId,
        artifactId,
        withLocation(analysis, itemById(itemId)?.location),
        checkWithItem(itemId)?.siteId,
      ),
    ),
  );
  updateItemAnalysis(itemId, {
    status: "analyzed",
    recovery: undefined,
    artifactId,
    checkId,
    sourceAnalysis: analysis,
    georeferencedAddress: analysis.georeferencedAddress || "",
    assessment: guidance.assessment,
    conditions: guidance.conditions || assessment.conditions,
    tasks: guidance.tasks || [],
  });
  checkDuplicates(itemId, guidance.tasks || [], analysis.analysisId);
}

/**
 * Kick off (or re-run) the capture pipeline for one item. Idempotent per item —
 * an already-active run is not restarted — so a manual "Retry" tap and the
 * auto-resume share one entry point. Called by capture, describe-instead, and
 * the perimeter check's resume path.
 * @param {string} itemId
 */
export function analyzeEvidenceItem(itemId, { manual = false } = {}) {
  const item = itemById(itemId);
  if (!item || active.has(itemId)) return;
  if (manual && !canManuallyRetry(item)) return;
  if (item.deletionPending) return;
  if (!manual && item.analysis?.status && !shouldResumeEvidenceItem(item))
    return;
  active.add(itemId); // Claim synchronously, before any mutation or await.
  void runOnce(itemId, manual)
    .catch(() => {})
    .finally(() => {
      active.delete(itemId);
      globalThis.dispatchEvent?.(
        new CustomEvent(EVIDENCE_SETTLED_EVENT, { detail: { itemId } }),
      );
    });
  return true;
}

/** Fired on window after each item run ends, however it ended. */
export const EVIDENCE_SETTLED_EVENT = "checkevidencesettled";

/**
 * Serialize an item's run across tabs. A tab that finds the item already
 * running elsewhere skips it: its in-memory copy may predate that tab's
 * upload, and replaying it would register a duplicate artifact.
 * @param {string} itemId
 */
function runOnce(itemId, manual) {
  const locks = globalThis.navigator?.locks;
  if (!locks) return run(itemId, manual);
  return locks.request(`check-item:${itemId}`, { ifAvailable: true }, (lock) =>
    lock ? run(itemId, manual) : undefined,
  );
}

/**
 * A transport failure (offline, dead zone, DNS): `ApiError` status 0 from
 * services/api.js. Timeouts and server errors are real failures.
 * @param {any} err
 */
export function isConnectionFailure(err) {
  return err?.status === 0 && err?.body?.code !== "analyses_pending";
}

/**
 * Should an item's pipeline be (re)started without a tap? Queued, running
 * and waiting-for-connection items resume, as do failures that only need
 * their analysis re-polled or their text re-registered.
 * @param {any} item
 */
export function shouldResumeEvidenceItem(item) {
  if (item?.captureSaving || item?.deletionPending) return false;
  const status = item?.analysis?.status;
  const recovery = item?.analysis?.recovery;
  if (["manual", "blocked"].includes(recovery?.state)) return false;
  if (recovery?.nextAttemptAt > Date.now()) return false;
  return (
    ["idle", "queued", "analyzing", "waiting"].includes(status) ||
    (status === "failed" && (!recovery || recovery.state === "scheduled"))
  );
}

/**
 * Start one bounded recovery cycle after automatic recovery is exhausted.
 * A server restart requires a confirmed exhausted generation; other stages
 * resume from their saved checkpoint. Ownership is claimed before any work.
 * @param {string} itemId
 */
export function retryEvidenceItem(itemId) {
  return analyzeEvidenceItem(itemId, { manual: true });
}

/**
 * Recover the exact registration metadata for an already-uploaded photo.
 * New sessions persist it at upload time; deriving it from the retained data
 * URL keeps interrupted sessions created by an older app version retryable.
 * Text artifacts have no S3 object and need no media metadata.
 * @param {any} item
 * @returns {Promise<{contentType?: string, contentLength?: number}>}
 */
async function retryMediaMetadata(item) {
  if (item.kind === "text") return {};
  if (
    typeof item.upload?.contentType === "string" &&
    Number.isInteger(item.upload?.contentLength) &&
    item.upload.contentLength > 0
  ) {
    return {
      contentType: item.upload.contentType,
      contentLength: item.upload.contentLength,
    };
  }
  if (item.media)
    return { contentType: item.media.type, contentLength: item.media.size };
  if (!item.dataUrl) {
    throw new ApiError("Uploaded photo metadata is unavailable", {
      status: 0,
      body: { code: "artifact_metadata_unavailable" },
    });
  }
  const blob = await dataUrlToBlob(item.dataUrl);
  return {
    contentType: contentTypeFromDataUrl(item.dataUrl),
    contentLength: blob.size,
  };
}

/**
 * Delete an evidence item from the session AND from the backend check.
 *
 * Local `removeItem` alone is not enough once capture is incremental: a
 * registered artifact has an ART# row (and usually an ANALYSIS#), and
 * completeCheck folds every registered artifact into the final scorecard —
 * leaving the row would file stale text (e.g. the pre-edit description) into
 * the run's permanent record.
 *
 * The backend delete goes first (it is the side that must not be skipped),
 * then the local item is removed. 404 = already deleted, which is success for
 * an idempotent UI. Everything else rethrows so the caller can keep the item
 * and surface the failure — silently dropping it locally would guarantee the
 * exact stale-artifact corruption this helper exists to prevent.
 * @param {string} itemId
 * @returns {Promise<void>}
 */
const evidenceRemovals = new Map();
export function removeEvidenceItem(itemId) {
  if (evidenceRemovals.has(itemId)) return evidenceRemovals.get(itemId);
  const check = checkWithItem(itemId);
  const item = sessionItem(check, itemId);
  if (!check || !item) return Promise.resolve();
  const artifactId = item.analysis?.artifactId || item.upload?.artifactId;
  if (artifactId && !connectionAvailable())
    return Promise.reject(
      new Error("Connection required to delete uploaded evidence"),
    );
  if (active.has(itemId))
    return Promise.reject(new Error("Evidence is still processing"));
  removingEvidence.add(itemId);
  const pending = Promise.resolve()
    .then(async () => {
      const wasPending = item.deletionPending;
      updateItem(itemId, { deletionPending: true });
      if (!(await confirmLocalSave(check))) {
        updateItem(itemId, { deletionPending: wasPending });
        throw new Error("Could not save evidence removal");
      }
      if (artifactId) {
        try {
          await deleteArtifact(check.id, artifactId, {
            originSiteId: check.siteId,
          });
        } catch (error) {
          if (error?.status !== 404) {
            const rejected =
              error?.status >= 400 &&
              error.status < 500 &&
              ![408, 429].includes(error.status);
            if (!rejected) throw error;
            // A previous interrupted DELETE may already have succeeded. A
            // rejection of its replay cannot establish whether the item exists.
            let alreadyDeleted = false;
            if (wasPending) {
              const detail = await getCheck(check.id, {
                originSiteId: check.siteId,
              });
              if (!Array.isArray(detail.artifacts)) throw error;
              alreadyDeleted = !detail.artifacts.some(
                (entry) => entry.artifactId === artifactId,
              );
            }
            if (!alreadyDeleted) {
              updateItem(itemId, { deletionPending: false });
              if (!(await confirmLocalSave(check))) {
                updateItem(itemId, { deletionPending: true });
                throw new Error("Could not save evidence removal");
              }
              throw error;
            }
          }
        }
      }
      const index = check.items.indexOf(item);
      if (item.media) {
        await deleteCapturePhoto(check, item.media.key);
        removeItem(itemId, { mediaDeleted: true });
      } else removeItem(itemId);
      if (!(await confirmLocalSave(check))) {
        check.items.splice(Math.max(0, index), 0, item);
        updateItemAnalysis(itemId, {});
        throw new Error("Could not save evidence removal");
      }
    })
    .finally(() => {
      evidenceRemovals.delete(itemId);
      removingEvidence.delete(itemId);
      if (itemById(itemId)) updateItemAnalysis(itemId, {});
    });
  evidenceRemovals.set(itemId, pending);
  updateItemAnalysis(itemId, {});
  return pending;
}

export async function refreshRecoveredQuestion(item, response) {
  if (!response?.assessment) throw new Error("Missing amended assessment");
  const refreshed = assessmentFromRefreshedAnalysis({
    checkId: item.checkId,
    artifactId: item.analysis.artifactId,
    analysisId: response.analysis_id,
    assessment: response.assessment,
    // Amended coordinates win; persisted evidence coordinates are only a fallback.
    location: hasCoordinates(response.assessment.metadata)
      ? null
      : hasCoordinates(item.location)
        ? item.location
        : item.analysis.conditions?.find((condition) =>
            hasCoordinates(condition.source),
          )?.source,
  });
  const guidance = await evaluateAmendedAssessment(
    refreshed,
    item.analysis.assessment.assessmentId,
  );
  if (!guidance) throw new Error("Missing amended guidance");
  return guidance;
}

/** Reuse one amendment identity across bounded revision-conflict retries. */
async function evaluateAmendedAssessment(
  refreshed,
  previousAssessmentId,
  canPublish = () => true,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await evaluateAssessment({ ...refreshed, previousAssessmentId });
    } catch (err) {
      if (
        err?.status !== 409 ||
        err?.body?.code !== "AssessmentRevisionConflict" ||
        !previousAssessmentId
      )
        throw err;
      const latest = await getAssessmentGuidance(previousAssessmentId);
      if (!canPublish()) return null;
      if (
        latest.assessment?.assessmentId &&
        latest.assessment.assessmentId !== previousAssessmentId
      )
        return latest;
      if (!latest.assessment || attempt === 2) throw err;
    }
  }
  return null;
}

export async function refreshEvidenceAnalysis(itemId, response, opts = {}) {
  const check = checkWithItem(itemId);
  if (!check) return;
  const item = sessionItem(check, itemId);
  if (!item || !response?.assessment) return;

  const artifactId = item.analysis?.artifactId || item.upload?.artifactId;
  if (!artifactId) return;
  const analysisId =
    response.analysis_id || item.analysis?.sourceAnalysis?.analysisId;
  const concerns = concernsFromAssessment(response.assessment);
  const refreshed = assessmentFromRefreshedAnalysis({
    checkId: check.id,
    artifactId,
    analysisId,
    assessment: response.assessment,
    location: item.location,
  });
  const previousAssessmentId = item.analysis?.assessment?.assessmentId;
  const guidance = await evaluateAmendedAssessment(
    refreshed,
    previousAssessmentId,
    () => isHeld(check),
  );
  if (!guidance) return;
  const reconciled = Boolean(
    guidance.assessment?.assessmentId &&
      guidance.assessment.assessmentId !== refreshed.assessmentId,
  );
  const publishedRaw = reconciled ? guidance.assessment.rawAssessment : null;
  const currentItem = itemById(itemId);
  const currentAssessmentId = currentItem?.analysis?.assessment?.assessmentId;
  if (
    currentAssessmentId !== previousAssessmentId &&
    currentAssessmentId !== guidance.assessment?.assessmentId
  )
    return;

  if (!isHeld(check)) return;
  updateItemAnalysis(itemId, {
    status: "analyzed",
    artifactId,
    checkId: check.id,
    sourceAnalysis: {
      ...(item.analysis?.sourceAnalysis || {}),
      analysisId,
      grade:
        publishedRaw?.grade ?? response.assessment.general_conditions?.label,
      gradeDescription:
        publishedRaw?.summary ??
        response.assessment.general_conditions?.description,
      concerns: publishedRaw?.concerns ?? concerns,
    },
    assessment: guidance.assessment,
    conditions: guidance.conditions || refreshed.conditions,
    tasks: guidance.tasks || [],
    ...(opts.rejectedConditionId
      ? {
          rejectedConditionIds: [
            ...(currentItem?.analysis?.rejectedConditionIds || []),
            opts.rejectedConditionId,
          ],
        }
      : {}),
  });
  checkDuplicates(itemId, guidance.tasks || [], analysisId);
}

export async function analyzeNoIssueDescriptionEdit(itemId, text) {
  const check = checkWithItem(itemId);
  const item = sessionItem(check, itemId);
  if (!check || !item) return null;

  const read = readCaptureDeviceLocation();
  await ensureRemoteCheck(check);
  const capturedAt = new Date().toISOString();
  let location = read.atUpload();
  const artifactId = await registerTextArtifact(check.id, {
    text,
    capturedAt,
    ...(location ?? {}),
  });
  let textItemId = null;
  let lateUnsent = false;
  if (!location) {
    // GPS hadn't answered yet; send its fix if one comes within 10 s.
    void read.later.then(async (late) => {
      if (!late) return;
      location = late;
      lateUnsent = true;
      if (textItemId)
        updateItem(textItemId, { location: late, locationUnsent: true });
      // textItemId can be set while this waits, so clear the flag here.
      if (await sendLocation(null, check.id, artifactId, late)) {
        lateUnsent = false;
        if (textItemId) updateItem(textItemId, { locationUnsent: false });
      }
    });
  }
  const analysis = await waitForArtifactAnalysis(check.id, artifactId);
  if (analysis.status && analysis.status !== "analyzed") {
    throw new ApiError("Analysis failed for edited description", {
      body: { code: "analysis_failed", artifactId },
    });
  }

  const { guidance } = await guidanceFromAnalysis(
    check.id,
    artifactId,
    withLocation(analysis, location),
  );
  const hasProblems = Boolean(
    (guidance.tasks || []).length || (guidance.conditions || []).length,
  );
  if (!hasProblems) {
    updateItemAnalysis(itemId, {
      noIssuesDescription: text,
      noIssuesTextArtifactId: artifactId,
      noIssuesTextAnalysis: analysis,
    });
    return { status: "no_problems", artifactId };
  }

  updateItemAnalysis(itemId, { hideNoIssuesCard: true });
  const textItem = addItem({
    kind: "text",
    text,
    uploadedAt: capturedAt,
    ...(location ? { location } : {}),
    ...(lateUnsent ? { locationUnsent: true } : {}),
  });
  if (!textItem) return { status: "problems", artifactId };
  textItemId = textItem.id;
  updateItem(textItem.id, {
    upload: { status: "uploaded", artifactId },
  });
  updateItemAnalysis(textItem.id, {
    status: "analyzed",
    artifactId,
    checkId: check.id,
    sourceAnalysis: analysis,
    assessment: guidance.assessment,
    conditions: guidance.conditions || [],
    tasks: guidance.tasks || [],
  });
  checkDuplicates(textItem.id, guidance.tasks || [], analysis.analysisId);
  return { status: "problems", artifactId, itemId: textItem.id };
}

/**
 * Submit an answer for an analyzer follow-up question and merge the refreshed
 * condition/task state back into the local capture item.
 * @param {string} itemId
 * @param {string} conditionId
 * @param {string} answerKey
 * @param {unknown} answerValue
 * @param {{assessment?: {assessmentId?: string, assessmentRevision?: number}, conditions?: any[], tasks?: any[]} | null} [publishedGuidance]
 * @returns {Promise<AnswerAnalysisQuestionResult>}
 */
export async function answerAnalysisQuestion(
  itemId,
  conditionId,
  answerKey,
  answerValue,
  publishedGuidance = null,
) {
  const check = checkWithItem(itemId);
  const item = sessionItem(check, itemId);
  const heldAssessmentId = item?.analysis?.assessment?.assessmentId;
  const assessmentId =
    publishedGuidance?.assessment?.assessmentId || heldAssessmentId;
  if (!check || !item || !assessmentId || !conditionId || !answerKey) {
    throw new ApiError("This item has no assessment to answer against.", {
      body: { code: "missing_assessment" },
    });
  }

  let result;
  try {
    result = await submitConditionAnswers(assessmentId, conditionId, {
      answers: { [answerKey]: answerValue },
    });
  } catch (err) {
    if (err?.body?.code === "AssessmentRevisionConflict") {
      const latest = await getAssessmentGuidance(assessmentId);
      const currentId = itemById(itemId)?.analysis?.assessment?.assessmentId;
      if (isHeld(check) && currentId === heldAssessmentId)
        updateItemAnalysis(itemId, latest);
    }
    throw err;
  }
  if (!isHeld(check)) return result;
  const latestItem = itemById(itemId);
  if (
    !latestItem ||
    latestItem.analysis?.assessment?.assessmentId !== heldAssessmentId
  )
    return result;
  if (
    latestItem.analysis?.assessment?.assessmentId === assessmentId &&
    (result?.assessmentItem?.assessmentRevision ?? 0) <
      (latestItem.analysis?.assessment?.assessmentRevision ?? 0)
  )
    return result;
  const condition = result?.conditionItem;
  const task = result?.taskItem;
  const baseline =
    !publishedGuidance ||
    (latestItem.analysis?.assessment?.assessmentId === assessmentId &&
      (latestItem.analysis.assessment.assessmentRevision || 0) >
        (publishedGuidance.assessment?.assessmentRevision || 0))
      ? latestItem.analysis
      : publishedGuidance;
  const existingConditions = baseline?.conditions || [];
  const nextConditions = existingConditions.map((candidate) =>
    candidate.conditionId === conditionId ? condition || candidate : candidate,
  );
  if (
    condition &&
    !nextConditions.some((candidate) => candidate.conditionId === conditionId)
  ) {
    nextConditions.push(condition);
  }

  const nextTasks = (baseline?.tasks || []).filter(
    (candidate) => candidate.conditionId !== conditionId,
  );
  if (task) nextTasks.push(task);

  updateItemAnalysis(itemId, {
    conditions: nextConditions,
    tasks: nextTasks,
    assessment: result?.assessmentItem || latestItem.analysis?.assessment,
  });
  checkDuplicates(
    itemId,
    nextTasks,
    latestItem.analysis?.sourceAnalysis?.analysisId,
  );
  return result;
}

async function run(itemId, manual = false) {
  const check = checkWithItem(itemId);
  const item = sessionItem(check, itemId);
  if (!check || !item) return;

  const assertOwner = async () => {
    if (
      !isHeld(check) ||
      (check.siteId && (await getSite())?.siteId !== check.siteId)
    )
      throw new DOMException("Check owner changed", "AbortError");
  };
  const startedAt = Date.now();
  try {
    await assertOwner();
    if (!(await confirmLocalSave(check))) {
      updateItemAnalysis(itemId, {
        status: "failed",
        localSaveConfirmed: false,
        recovery: { stage: "storage", state: "manual", attempts: 0 },
      });
      return;
    }
    if (!connectionAvailable())
      throw Object.assign(new Error("Connection unavailable"), { status: 0 });
    const recovery = manual
      ? { ...item.analysis?.recovery, attempts: 0 }
      : item.analysis?.recovery;
    updateItemAnalysis(itemId, {
      status: "queued",
      localSaveConfirmed: true,
      recovery: { ...recovery, state: "working", nextAttemptAt: undefined },
    });
    if (
      (manual || item.analysis?.restartRequestId) &&
      item.analysis?.serverGeneration &&
      ["analyze", "restart"].includes(recovery?.stage)
    ) {
      const retryRequestId = item.analysis.restartRequestId || photoAttemptId();
      updateItemAnalysis(itemId, { restartRequestId: retryRequestId });
      if (!(await confirmLocalSave(check)))
        throw Object.assign(new Error("Storage unavailable"), {
          leg: "storage",
          status: 400,
        });
      const metadata = await retryMediaMetadata(item);
      await withLeg("restart", () =>
        registerArtifact(
          check.id,
          {
            artifactId: item.analysis.artifactId || item.upload?.artifactId,
            s3Key: item.analysis.s3Key || item.upload?.s3Key,
            ...metadata,
            ...(item.kind === "text" ? { text: item.text } : {}),
            retryRequestId,
            expectedGeneration: item.analysis.serverGeneration,
          },
          { originSiteId: check.siteId },
        ),
      );
      updateItemAnalysis(itemId, {
        sourceAnalysis: undefined,
        serverGeneration: undefined,
        restartRequestId: undefined,
      });
    }
    const read =
      hasCoordinates(item.location) ||
      item.analysis?.artifactId ||
      item.upload?.artifactId
        ? null
        : readCaptureDeviceLocation(
            item.kind === "text" ? undefined : check.flowType,
          );
    const uploadLocation = () => (read ? read.atUpload() : item.location);
    updateItemAnalysis(itemId, { status: "queued" });
    const artifactId = await withUploadSlot(async () => {
      await assertOwner();
      if (item.kind === "photo" && item.upload?.status !== "uploaded")
        updateItem(itemId, { upload: { ...item.upload, status: "uploading" } });
      await withLeg("start", () => ensureRemoteCheck(check));
      // An interrupted run may have completed the upload before analysis started:
      // the artifact coordinates then live only under `upload`. Adopt them here
      // so run() and the poll both see them instead of re-uploading.
      let artifactId =
        item.analysis?.artifactId ||
        (item.upload?.status === "uploaded"
          ? item.upload?.artifactId
          : undefined);
      if (artifactId && !item.analysis?.artifactId) {
        updateItemAnalysis(itemId, {
          artifactId,
          ...(item.upload?.s3Key ? { s3Key: item.upload.s3Key } : {}),
        });
      }
      if (!artifactId) {
        if (item.kind === "text") {
          updateItem(itemId, {
            upload: { ...item.upload, status: "uploading" },
          });
          const textArtifactId = item.upload?.artifactId || photoAttemptId();
          updateItem(itemId, {
            upload: {
              ...item.upload,
              artifactId: textArtifactId,
              status: "uploading",
            },
          });
          if (!(await confirmLocalSave(check)))
            throw Object.assign(new Error("Storage unavailable"), {
              leg: "storage",
              status: 400,
            });
          artifactId = await withLeg("upload", () =>
            registerTextArtifact(check.id, {
              artifactId: textArtifactId,
              originSiteId: check.siteId,
              text: item.text,
              capturedAt: item.uploadedAt,
              ...(uploadLocation() ?? {}),
            }),
          );
          updateItem(itemId, {
            upload: { status: "uploaded", artifactId },
          });
        } else {
          updateItem(itemId, {
            upload: { ...item.upload, status: "uploading" },
          });
          let original = item.media
            ? (await getCaptureMedia(item.media.key))?.original
            : null;
          if (item.media && !original)
            throw Object.assign(new Error("Pending original is unavailable"), {
              leg: "storage",
              status: 400,
            });
          const {
            artifactId: uploadedId,
            s3Key,
            contentType,
            contentLength,
          } = await withLeg("upload", () =>
            uploadArtifact(check.id, {
              ...(original ? { blob: original } : { dataUrl: item.dataUrl }),
              capturedAt: item.uploadedAt,
              location: uploadLocation,
              ...(item.note ? { text: item.note } : {}),
              tag: item.id,
              checkpoint: item.upload,
              originSiteId: check.siteId,
              onCheckpoint: async (checkpoint) => {
                updateItem(itemId, {
                  upload: { ...checkpoint, status: "uploading" },
                });
                if (!(await confirmLocalSave(check)))
                  throw Object.assign(new Error("Storage unavailable"), {
                    leg: "storage",
                    status: 400,
                  });
              },
              onLeg: (leg) => {
                if (leg === LEG.PUT) {
                  // Bytes reached S3 — the card's "Photo uploaded" check.
                  updateItemAnalysis(itemId, {
                    stages: { uploaded: new Date().toISOString() },
                  });
                }
                // presign/register are sub-second steps; the "sent to analyzer"
                // stamp lands when evaluateArtifact takes over, which is the
                // point the user cares about.
              },
            }),
          );
          original = null;
          artifactId = uploadedId;
          // Persist the s3Key with the artifact: retry re-registers the SAME
          // artifact from these coordinates (no new upload, no new object).
          updateItem(itemId, {
            upload: {
              status: "uploaded",
              artifactId,
              s3Key,
              contentType,
              contentLength,
            },
          });
          updateItemAnalysis(itemId, { s3Key });
        }
      }
      const sent = read?.atUpload();
      if (sent) updateItem(itemId, { location: sent });
      else if (read) {
        // GPS hadn't answered yet; send its fix if one comes within 10 s.
        void read.later.then((location) => {
          if (!location) return;
          updateItem(itemId, { location, locationUnsent: true });
          return sendLocation(itemId, check.id, artifactId, location);
        });
      }
      return artifactId;
    });
    if (!(await confirmLocalSave(check)))
      throw Object.assign(new Error("Storage unavailable"), {
        leg: "storage",
        status: 400,
      });
    await assertOwner();
    if (item.media && item.upload?.status === "uploaded")
      // Cleanup failure leaves recoverable bytes; it must not stop analysis.
      await releaseCaptureOriginal(item.media.key, artifactId).catch(() => {});
    await evaluateArtifact(check.id, itemId, artifactId);
  } catch (err) {
    // Pausing or leaving a check stops its poll; it is not an analysis failure.
    if (err?.name === "AbortError") return;
    const latestItem = itemById(itemId);
    if (!latestItem || !isHeld(check)) return;
    if (err?.body?.code === "analyses_pending") {
      updateItemAnalysis(itemId, {
        status: "analyzing",
        recovery: {
          stage: "analyze",
          state: "scheduled",
          attempts: 0,
          nextAttemptAt: Date.now() + 15_000,
        },
      });
    } else if (err?.leg === "storage") {
      updateItemAnalysis(itemId, {
        status: "failed",
        localSaveConfirmed: false,
        recovery: { stage: "storage", state: "manual", attempts: 0 },
      });
    } else if (isConnectionFailure(err) || !connectionAvailable()) {
      updateItemAnalysis(itemId, {
        status: "waiting",
        localSaveConfirmed: await confirmLocalSave(check),
        recovery: {
          ...latestItem.analysis?.recovery,
          state: "waiting",
          nextAttemptAt: undefined,
        },
        error: undefined,
        failure: undefined,
      });
    } else {
      const stage = err?.leg || "start";
      const recovery = failedRecovery(
        latestItem.analysis?.recovery,
        stage,
        err,
      );
      updateItemAnalysis(itemId, {
        status: recovery.state === "scheduled" ? "queued" : "failed",
        recovery,
        lastTriedAt: new Date().toISOString(),
        failure: {
          leg: stage === "restart" ? "analyze" : stage,
          uploaded: latestItem.upload?.status === "uploaded",
          waitedMs: Date.now() - startedAt,
        },
      });
    }
    await confirmLocalSave(check);
  }
}

/** Resume independent matching after a human separation restores task identity. */
export function restartDuplicateChecks(itemId) {
  const item = itemById(itemId);
  if (item)
    checkDuplicates(
      itemId,
      item.analysis?.tasks || [],
      item.analysis?.sourceAnalysis?.analysisId,
    );
}
