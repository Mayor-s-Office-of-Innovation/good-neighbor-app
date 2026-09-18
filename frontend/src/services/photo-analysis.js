// @ts-nocheck -- matches the surrounding frontend migration baseline.
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
  evaluateAssessment,
  getAssessmentGuidance,
  getCheck,
  registerArtifact,
  submitConditionAnswers,
  uploadArtifact,
  registerTextArtifact,
  ApiError,
  LEG,
} from "./api.js";
import { getCaptureDeviceLocation } from "./device-location.js";
import {
  addItem,
  getCurrentCheck,
  getPlaceOrder,
  updateItem,
  updateItemAnalysis,
} from "../state/check-session.js";

const POLL_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 2000;

/**
 * One human-readable progress stage the card shows as it happens:
 *   uploaded — media bytes reached S3 (or text registered)
 *   sent     — the artifact is registered and the analyzer is working on it
 *   waiting  — polling for the result (shown with a live elapsed timer)
 * Stamps persist per stage (ISO timestamps) so a card can show how long each
 * step took and, after a failure, how long we waited overall.
 * @typedef {{ uploaded?: string, sent?: string, waiting?: string }} AnalysisStages
 */

const active = new Set();

/**
 * @typedef {object} AnswerAnalysisQuestionResult
 * @property {Record<string, unknown>} [assessmentItem] Updated guidance assessment.
 * @property {Record<string, unknown>} [conditionItem] Updated answered condition.
 * @property {Record<string, unknown> | null} [taskItem] Task created for the answer, when applicable.
 * @property {Record<string, unknown> | null} [evaluation] Rulebase evaluation returned by the backend.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Reduce a pipeline failure to what the card should say: which step broke, what
 * had already succeeded, and how long we waited before giving up.
 * @param {unknown} err
 * @returns {{ leg: "start" | "upload" | "analyze" | "evaluate" | string, uploaded: boolean, enqueued: boolean, waitedMs?: number }}
 */
function describeFailure(err) {
  const body = /** @type {any} */ (err)?.body ?? {};
  // The analyzer poll timed out: upload + enqueue both succeeded, and the
  // deadline tells the user exactly how long we waited.
  if (body?.code === "analyses_pending") {
    return {
      leg: "analyze",
      uploaded: true,
      enqueued: true,
      waitedMs: POLL_TIMEOUT_MS,
    };
  }
  const leg = /** @type {any} */ (err)?.leg;
  // Analyzer/guidance legs imply upload + enqueue already succeeded.
  if (leg === "analyze" || leg === "evaluate") {
    return { leg, uploaded: true, enqueued: true };
  }
  if (leg) return { leg, uploaded: false, enqueued: false };
  return { leg: "start", uploaded: false, enqueued: false };
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

function placesPayload(check) {
  return (check.placeOrder || getPlaceOrder()).map((placeId) => ({
    placeId,
    placeName: check.places[placeId].name,
    skipped: !!check.places[placeId].skipped,
  }));
}

async function ensureRemoteCheck(check) {
  if (check.remoteStarted) return;
  await createCheck(check.id, { places: placesPayload(check) });
  check.remoteStarted = true;
}

async function waitForArtifactAnalysis(
  checkId,
  artifactId,
  { timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = await getCheck(checkId);
  while (true) {
    const analysis = (last.analyses || []).find(
      (item) => item.artifactId === artifactId,
    );
    if (analysis) return analysis;
    if (Date.now() >= deadline) {
      throw new ApiError(`Analysis still processing for ${artifactId}`, {
        body: { code: "analyses_pending", artifactId },
      });
    }
    await sleep(intervalMs);
    last = await getCheck(checkId);
  }
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
        sourceArtifactIds: [artifactId],
        evidenceIndices: concern.evidenceIndices || [],
      })),
    ...(hasCoordinates(analysis)
      ? {
          assessment: {
            metadata: {
              position_descriptor: analysis.placeName || "perimeter",
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

function hasCoordinates(value) {
  return (
    Number.isFinite(value?.latitude) &&
    Number.isFinite(value?.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

async function guidanceFromAnalysis(checkId, artifactId, analysis) {
  const assessment = assessmentFromAnalysis({ checkId, artifactId, analysis });
  const guidance = await evaluateAssessment(assessment);
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

async function evaluateArtifact(checkId, placeId, itemId, artifactId) {
  updateItemAnalysis(placeId, itemId, {
    status: "analyzing",
    artifactId,
    // Merge onto the existing stages — a full object here would discard the
    // earlier `uploaded` stamp (updateItemAnalysis merges shallowly).
    stages: {
      ...(getCurrentCheck()?.places?.[placeId]?.items?.find(
        (candidate) => candidate.id === itemId,
      )?.analysis?.stages || {}),
      sent: new Date().toISOString(),
    },
  });
  const analysis = await withLeg("analyze", () =>
    waitForArtifactAnalysis(checkId, artifactId),
  );
  if (analysis.status && analysis.status !== "analyzed") {
    updateItemAnalysis(placeId, itemId, {
      status: "failed",
      artifactId,
      error: analysis.error?.message || "Analysis failed.",
      failure: {
        leg: "analyze",
        uploaded: true,
        enqueued: true,
        backendError: true,
      },
    });
    return;
  }

  const { assessment, guidance } = await withLeg("evaluate", () =>
    guidanceFromAnalysis(checkId, artifactId, analysis),
  );
  updateItemAnalysis(placeId, itemId, {
    status: "analyzed",
    artifactId,
    checkId,
    sourceAnalysis: analysis,
    assessment: guidance.assessment,
    conditions: guidance.conditions || assessment.conditions,
    tasks: guidance.tasks || [],
  });
}

/**
 * Kick off (or re-run) the capture pipeline for one item. Idempotent per item —
 * an already-active run is not restarted — so a manual "Retry" tap and the
 * auto-resume share one entry point. Called by capture, describe-instead, and
 * the perimeter check's resume path.
 * @param {string} placeId
 * @param {string} itemId
 */
export function analyzeEvidenceItem(placeId, itemId) {
  const key = `${placeId}:${itemId}`;
  if (active.has(key)) return;
  active.add(key);
  void run(placeId, itemId).finally(() => active.delete(key));
}

/**
 * Manual retry from a failed card.
 *
 * - A failed ANALYZE leg (timeout or backend error): the artifact is already
 *   registered, so we re-drive via `registerArtifact` with the SAME artifactId
 *   (+ s3Key) — the backend re-enqueues on that path by design, so the worker
 *   makes a fresh analyzer call instead of the client re-polling a dead
 *   message or an old failure marker.
 * - A failed UPLOAD leg (or any missing artifact): replay the whole pipeline.
 * - An upload-only state (interrupt between PUT and analysis-start): seed the
 *   persisted `upload.artifactId`/`s3Key` into `analysis` so the poll path can
 *   see it (run() reads only `analysis.artifactId`).
 *
 * All paths reuse `analyzeEvidenceItem`'s idempotent-run guard.
 * @param {string} placeId
 * @param {string} itemId
 */
export function retryEvidenceItem(placeId, itemId) {
  const check = getCurrentCheck();
  const item = check?.places?.[placeId]?.items?.find(
    (candidate) => candidate.id === itemId,
  );
  if (!item) return;

  const analysisArtifactId = item.analysis?.artifactId;
  const uploadArtifactId = item.upload?.artifactId;
  const artifactId = analysisArtifactId || uploadArtifactId;
  const isUploadLeg = item.analysis?.failure?.leg === "upload";
  const analyzeLegFailure = Boolean(
    !isUploadLeg &&
      artifactId &&
      (item.analysis?.failure || item.analysis?.status === "failed"),
  );

  if (analyzeLegFailure) {
    // Seed the artifact coordinates so run() and the poll both see them.
    if (uploadArtifactId && !analysisArtifactId) {
      updateItemAnalysis(placeId, itemId, {
        artifactId: uploadArtifactId,
        ...(item.upload?.s3Key ? { s3Key: item.upload.s3Key } : {}),
      });
    }
    updateItemAnalysis(placeId, itemId, {
      status: "analyzing",
      error: undefined,
      failure: undefined,
    });
    // Re-register the same artifact: conditional write + always-enqueue on
    // the backend means a fresh analyze message with zero new upload. Then
    // run the pipeline again — run() adopts the coordinates and polls.
    void withLeg("start", () =>
      registerArtifact(check.id, {
        artifactId: analysisArtifactId || uploadArtifactId,
        placeId,
        placeName: item.placeName || check.places?.[placeId]?.name || "",
        s3Key: item.analysis?.s3Key || item.upload?.s3Key,
        capturedAt: item.uploadedAt,
        ...(hasCoordinates(item.location) ? item.location : {}),
        ...(item.kind === "text" ? { text: item.text } : {}),
        ...(item.note ? { text: item.note } : {}),
      }),
    )
      .then(() => {
        analyzeEvidenceItem(placeId, itemId);
      })
      .catch((err) => {
        // 409 = already registered — the backend enqueued on that path too,
        // so a poll is still the right next step.
        if (/** @type {any} */ (err)?.status === 409) {
          analyzeEvidenceItem(placeId, itemId);
          return;
        }
        console.error("retryEvidenceItem re-register failed", err);
        updateItemAnalysis(placeId, itemId, {
          status: "failed",
          error: "Could not restart the analysis. Please try again.",
          failure: { leg: "start", uploaded: true, enqueued: false },
        });
      });
    return;
  }

  // Upload-leg failure (or never got far enough): replay the pipeline.
  updateItem(placeId, itemId, { upload: { status: "failed" } });
  updateItemAnalysis(placeId, itemId, {
    status: "queued",
    error: undefined,
    failure: undefined,
  });
  analyzeEvidenceItem(placeId, itemId);
}

export async function refreshEvidenceAnalysis(
  placeId,
  itemId,
  response,
  opts = {},
) {
  const check = getCurrentCheck();
  if (!check) return;
  const place = check.places?.[placeId];
  const item = place?.items?.find((candidate) => candidate.id === itemId);
  if (!place || !item || !response?.assessment) return;

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
  let guidance;
  let reconciled = false;
  const previousAssessmentId = item.analysis?.assessment?.assessmentId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      guidance = await evaluateAssessment({
        ...refreshed,
        previousAssessmentId,
      });
      break;
    } catch (err) {
      if (
        err?.status !== 409 ||
        err?.body?.code !== "AssessmentRevisionConflict" ||
        !previousAssessmentId
      )
        throw err;
      const latest = await getAssessmentGuidance(previousAssessmentId);
      if (getCurrentCheck()?.id !== check.id) return;
      if (latest.assessment?.assessmentId !== previousAssessmentId) {
        // Another refresh won. Use its persisted analysis as well as guidance;
        // never replay this older analyzer payload against the new predecessor.
        guidance = latest;
        reconciled = true;
        break;
      }
      if (attempt === 2) throw err;
      // Same predecessor: an answer changed. The backend reloads those answers
      // on the next evaluation; the analyzer amendment is not repeated.
    }
  }
  reconciled ||= Boolean(
    guidance.assessment?.assessmentId &&
      guidance.assessment.assessmentId !== refreshed.assessmentId,
  );
  const publishedRaw = reconciled ? guidance.assessment.rawAssessment : null;
  const currentItem = getCurrentCheck()?.places?.[placeId]?.items?.find(
    (candidate) => candidate.id === itemId,
  );
  const currentAssessmentId = currentItem?.analysis?.assessment?.assessmentId;
  if (
    currentAssessmentId !== previousAssessmentId &&
    currentAssessmentId !== guidance.assessment?.assessmentId
  )
    return;

  if (getCurrentCheck()?.id !== check.id) return;
  updateItemAnalysis(placeId, itemId, {
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
}

export async function analyzeNoIssueDescriptionEdit(placeId, itemId, text) {
  const check = getCurrentCheck();
  const place = check?.places?.[placeId];
  const item = place?.items?.find((candidate) => candidate.id === itemId);
  if (!check || !place || !item) return null;

  await ensureRemoteCheck(check);
  const capturedAt = new Date().toISOString();
  const location = await getCaptureDeviceLocation();
  const artifactId = await registerTextArtifact(check.id, {
    placeId,
    placeName: place.name,
    text,
    capturedAt,
    ...(location ?? {}),
  });
  const analysis = await waitForArtifactAnalysis(check.id, artifactId);
  if (analysis.status && analysis.status !== "analyzed") {
    throw new ApiError("Analysis failed for edited description", {
      body: { code: "analysis_failed", artifactId },
    });
  }

  const { guidance } = await guidanceFromAnalysis(
    check.id,
    artifactId,
    analysis,
  );
  const hasProblems = Boolean(
    (guidance.tasks || []).length || (guidance.conditions || []).length,
  );
  if (!hasProblems) {
    updateItemAnalysis(placeId, itemId, {
      noIssuesDescription: text,
      noIssuesTextArtifactId: artifactId,
      noIssuesTextAnalysis: analysis,
    });
    return { status: "no_problems", artifactId };
  }

  updateItemAnalysis(placeId, itemId, { hideNoIssuesCard: true });
  const textItem = addItem(placeId, {
    kind: "text",
    text,
    uploadedAt: capturedAt,
    ...(location ? { location } : {}),
  });
  if (!textItem) return { status: "problems", artifactId };
  updateItem(placeId, textItem.id, {
    upload: { status: "uploaded", artifactId },
  });
  updateItemAnalysis(placeId, textItem.id, {
    status: "analyzed",
    artifactId,
    checkId: check.id,
    sourceAnalysis: analysis,
    assessment: guidance.assessment,
    conditions: guidance.conditions || [],
    tasks: guidance.tasks || [],
  });
  return { status: "problems", artifactId, itemId: textItem.id };
}

/**
 * Submit an answer for an analyzer follow-up question and merge the refreshed
 * condition/task state back into the local capture item.
 * @param {string} placeId
 * @param {string} itemId
 * @param {string} conditionId
 * @param {string} answerKey
 * @param {unknown} answerValue
 * @returns {Promise<AnswerAnalysisQuestionResult>}
 */
export async function answerAnalysisQuestion(
  placeId,
  itemId,
  conditionId,
  answerKey,
  answerValue,
) {
  const check = getCurrentCheck();
  const place = check?.places?.[placeId];
  const item = place?.items?.find((candidate) => candidate.id === itemId);
  const assessmentId = item?.analysis?.assessment?.assessmentId;
  if (
    !check ||
    !place ||
    !item ||
    !assessmentId ||
    !conditionId ||
    !answerKey
  ) {
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
      const current = getCurrentCheck();
      const currentId = current?.places?.[placeId]?.items?.find(
        (candidate) => candidate.id === itemId,
      )?.analysis?.assessment?.assessmentId;
      if (current?.id === check.id && currentId === assessmentId)
        updateItemAnalysis(placeId, itemId, latest);
    }
    throw err;
  }
  if (getCurrentCheck()?.id !== check.id) return result;
  const latestItem = getCurrentCheck()?.places?.[placeId]?.items?.find(
    (candidate) => candidate.id === itemId,
  );
  if (
    !latestItem ||
    latestItem.analysis?.assessment?.assessmentId !== assessmentId
  )
    return result;
  if (
    (result?.assessmentItem?.assessmentRevision ?? 0) <
    (latestItem.analysis?.assessment?.assessmentRevision ?? 0)
  )
    return result;
  const condition = result?.conditionItem;
  const task = result?.taskItem;
  const existingConditions = latestItem.analysis?.conditions || [];
  const nextConditions = existingConditions.map((candidate) =>
    candidate.conditionId === conditionId ? condition || candidate : candidate,
  );
  if (
    condition &&
    !nextConditions.some((candidate) => candidate.conditionId === conditionId)
  ) {
    nextConditions.push(condition);
  }

  const nextTasks = (latestItem.analysis?.tasks || []).filter(
    (candidate) => candidate.conditionId !== conditionId,
  );
  if (task) nextTasks.push(task);

  updateItemAnalysis(placeId, itemId, {
    conditions: nextConditions,
    tasks: nextTasks,
    assessment: result?.assessmentItem || latestItem.analysis?.assessment,
  });
  return result;
}

async function run(placeId, itemId) {
  const check = getCurrentCheck();
  const place = check?.places?.[placeId];
  const item = place?.items?.find((candidate) => candidate.id === itemId);
  if (!check || !place || !item) return;

  const startedAt = Date.now();
  try {
    const locationPromise = hasCoordinates(item.location)
      ? Promise.resolve(item.location)
      : getCaptureDeviceLocation();
    updateItemAnalysis(placeId, itemId, { status: "queued" });
    await withLeg("start", () => ensureRemoteCheck(check));
    const location = await locationPromise;
    if (location && !hasCoordinates(item.location)) {
      updateItem(placeId, itemId, { location });
    }
    // An interrupted run may have completed the upload before analysis started:
    // the artifact coordinates then live only under `upload`. Adopt them here
    // so run() and the poll both see them instead of re-uploading.
    let artifactId = item.analysis?.artifactId || item.upload?.artifactId;
    if (artifactId && !item.analysis?.artifactId) {
      updateItemAnalysis(placeId, itemId, {
        artifactId,
        ...(item.upload?.s3Key ? { s3Key: item.upload.s3Key } : {}),
      });
    }
    if (!artifactId) {
      if (item.kind === "text") {
        updateItem(placeId, itemId, { upload: { status: "uploading" } });
        artifactId = await withLeg("upload", () =>
          registerTextArtifact(check.id, {
            placeId,
            placeName: place.name,
            text: item.text,
            capturedAt: item.uploadedAt,
            ...(location ?? {}),
          }),
        );
        updateItem(placeId, itemId, {
          upload: { status: "uploaded", artifactId },
        });
      } else {
        updateItem(placeId, itemId, { upload: { status: "uploading" } });
        const { artifactId: uploadedId, s3Key } = await withLeg("upload", () =>
          uploadArtifact(check.id, {
            placeId,
            placeName: place.name,
            dataUrl: item.dataUrl,
            capturedAt: item.uploadedAt,
            ...(location ?? {}),
            ...(item.note ? { text: item.note } : {}),
            tag: `${place.name}:${item.id}`,
            onLeg: (leg) => {
              if (leg === LEG.PUT) {
                // Bytes reached S3 — the card's "Photo uploaded" check.
                updateItemAnalysis(placeId, itemId, {
                  stages: { uploaded: new Date().toISOString() },
                });
              }
              // presign/register are sub-second steps; the "sent to analyzer"
              // stamp lands when evaluateArtifact takes over, which is the
              // point the user cares about.
            },
          }),
        );
        artifactId = uploadedId;
        // Persist the s3Key with the artifact: retry re-registers the SAME
        // artifact from these coordinates (no new upload, no new object).
        updateItem(placeId, itemId, {
          upload: { status: "uploaded", artifactId, s3Key },
        });
        updateItemAnalysis(placeId, itemId, { s3Key });
      }
    }
    await evaluateArtifact(check.id, placeId, itemId, artifactId);
  } catch (err) {
    console.error("analyzeEvidenceItem failed", err);
    const failure = describeFailure(err);
    const latestItem = getCurrentCheck()?.places?.[placeId]?.items?.find(
      (candidate) => candidate.id === itemId,
    );
    const hasUploadedArtifact = Boolean(
      latestItem?.upload?.status === "uploaded" &&
        (latestItem?.analysis?.artifactId || latestItem?.upload?.artifactId),
    );
    updateItem(placeId, itemId, {
      upload: {
        ...(latestItem?.upload || item.upload || {}),
        status: hasUploadedArtifact ? "uploaded" : "failed",
      },
    });
    updateItemAnalysis(placeId, itemId, {
      status: "failed",
      error:
        err?.body?.code === "analyses_pending"
          ? "Analysis is taking longer than expected."
          : "Could not analyze this item.",
      failure: {
        // What the card reports: which step broke, what had succeeded, and
        // how long we waited before giving up.
        leg: failure.leg,
        uploaded: hasUploadedArtifact || failure.uploaded,
        enqueued: failure.enqueued,
        waitedMs: Date.now() - startedAt,
      },
    });
  }
}
