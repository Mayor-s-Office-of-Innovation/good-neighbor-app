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
  getCheck,
  uploadArtifact,
  registerTextArtifact,
  ApiError,
} from "./api.js";
import {
  addItem,
  getCurrentCheck,
  getPlaceOrder,
  updateItem,
  updateItemAnalysis,
} from "../state/check-session.js";

const POLL_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 2000;

const active = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
        description: concern.explanation || "",
        sourceArtifactIds: [artifactId],
        evidenceIndices: concern.evidenceIndices || [],
      })),
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

async function guidanceFromAnalysis(checkId, artifactId, analysis) {
  const assessment = assessmentFromAnalysis({ checkId, artifactId, analysis });
  const guidance = assessment.conditions.length
    ? await evaluateAssessment(assessment)
    : { assessment, conditions: [], tasks: [] };
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
    explanation: condition.description || "",
    evidenceIndices: condition.evidence_indices || [],
  }));
}

function assessmentFromRefreshedAnalysis({
  checkId,
  artifactId,
  analysisId,
  assessment,
}) {
  const analyzedAt = new Date().toISOString();
  const concerns = concernsFromAssessment(assessment);
  const revision = analyzedAt.replace(/[^0-9]/g, "");
  return {
    assessmentId: `${checkId}-${artifactId}-${revision}`,
    checkId,
    reportedAt:
      assessment?.metadata?.reported_at || assessment?.created_at || analyzedAt,
    rubricVersion: undefined,
    grade: assessment?.general_conditions?.label || null,
    conditions: concerns
      .filter((concern) => (concern.rating || 0) > 0)
      .map((concern, index) => ({
        conditionId: conditionId(artifactId, concern, index),
        category: concern.category,
        severity: concern.rating,
        severityLabel: concern.ratingLabel,
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
  });
  const analysis = await waitForArtifactAnalysis(checkId, artifactId);
  if (analysis.status && analysis.status !== "analyzed") {
    updateItemAnalysis(placeId, itemId, {
      status: "failed",
      artifactId,
      error: analysis.error?.message || "Analysis failed.",
    });
    return;
  }

  const { assessment, guidance } = await guidanceFromAnalysis(
    checkId,
    artifactId,
    analysis,
  );
  updateItemAnalysis(placeId, itemId, {
    status: "analyzed",
    artifactId,
    sourceAnalysis: analysis,
    assessment: guidance.assessment,
    conditions: guidance.conditions || assessment.conditions,
    tasks: guidance.tasks || [],
  });
}

/**
 * Start upload/register/analyze/evaluate for one session evidence item.
 * @param {string} placeId
 * @param {string} itemId
 */
export function analyzeEvidenceItem(placeId, itemId) {
  const key = `${placeId}:${itemId}`;
  if (active.has(key)) return;
  active.add(key);
  void run(placeId, itemId).finally(() => active.delete(key));
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
  });
  const guidance = refreshed.conditions.length
    ? await evaluateAssessment(refreshed)
    : { assessment: refreshed, conditions: [], tasks: [] };

  updateItemAnalysis(placeId, itemId, {
    status: "analyzed",
    artifactId,
    sourceAnalysis: {
      ...(item.analysis?.sourceAnalysis || {}),
      analysisId,
      grade: response.assessment.general_conditions?.label,
      gradeDescription: response.assessment.general_conditions?.description,
      concerns,
    },
    assessment: guidance.assessment,
    conditions: guidance.conditions || refreshed.conditions,
    tasks: guidance.tasks || [],
    ...(opts.rejectedConditionId
      ? {
          rejectedConditionIds: [
            ...(item.analysis?.rejectedConditionIds || []),
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
  const artifactId = await registerTextArtifact(check.id, {
    placeId,
    placeName: place.name,
    text,
    capturedAt,
  });
  const analysis = await waitForArtifactAnalysis(check.id, artifactId);
  if (analysis.status && analysis.status !== "analyzed") {
    throw new ApiError("Analysis failed for edited description", {
      body: { code: "analysis_failed", artifactId },
    });
  }

  const { guidance } = await guidanceFromAnalysis(check.id, artifactId, analysis);
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
  });
  if (!textItem) return { status: "problems", artifactId };
  updateItem(placeId, textItem.id, {
    upload: { status: "uploaded", artifactId },
  });
  updateItemAnalysis(placeId, textItem.id, {
    status: "analyzed",
    artifactId,
    sourceAnalysis: analysis,
    assessment: guidance.assessment,
    conditions: guidance.conditions || [],
    tasks: guidance.tasks || [],
  });
  return { status: "problems", artifactId, itemId: textItem.id };
}

async function run(placeId, itemId) {
  const check = getCurrentCheck();
  const place = check?.places?.[placeId];
  const item = place?.items?.find((candidate) => candidate.id === itemId);
  if (!check || !place || !item) return;

  try {
    updateItemAnalysis(placeId, itemId, { status: "queued" });
    await ensureRemoteCheck(check);
    let artifactId = item.analysis?.artifactId;
    if (!artifactId) {
      if (item.kind === "text") {
        updateItem(placeId, itemId, { upload: { status: "uploaded" } });
        artifactId = await registerTextArtifact(check.id, {
          placeId,
          placeName: place.name,
          text: item.text,
          capturedAt: item.uploadedAt,
        });
        updateItem(placeId, itemId, {
          upload: { status: "uploaded", artifactId },
        });
      } else {
        updateItem(placeId, itemId, { upload: { status: "uploading" } });
        artifactId = await uploadArtifact(check.id, {
          placeId,
          placeName: place.name,
          dataUrl: item.dataUrl,
          capturedAt: item.uploadedAt,
          ...(item.note ? { text: item.note } : {}),
          tag: `${place.name}:${item.id}`,
        });
        updateItem(placeId, itemId, {
          upload: { status: "uploaded", artifactId },
        });
      }
    }
    await evaluateArtifact(check.id, placeId, itemId, artifactId);
  } catch (err) {
    console.error("analyzeEvidenceItem failed", err);
    updateItem(placeId, itemId, {
      upload: {
        ...(item.upload || {}),
        status: item.upload?.status || "failed",
      },
    });
    updateItemAnalysis(placeId, itemId, {
      status: "failed",
      error:
        err?.body?.code === "analyses_pending"
          ? "Analysis is taking longer than expected."
          : "Could not analyze this item.",
    });
  }
}
