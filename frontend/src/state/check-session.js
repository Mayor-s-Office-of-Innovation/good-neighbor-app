// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  The in-progress perimeter check — the walk's working state.

  Held in memory as a module singleton (survives hash-route changes, no reload) AND
  mirrored to IndexedDB (db.js `draft` store) on every mutation, so a walk survives
  reload / app-close and can be resumed from home. On submit the walk goes to the
  backend (services/submit-check.js); history + the last-log summary read it back
  from there (services/api.js), not from any local `checks` store.

  A check has four fixed sides (N/E/S/W). Each side is covered by photo captures, or
  marked "skipped" (still counted "of 4"). The item API stays kind-agnostic on purpose:
  voice/note capture is out of the MVP UI (photo-only) but the plumbing is left intact
  for the post-MVP pass.
*/
import {
  newId,
  saveDraft,
  clearDraft,
  getDraft,
  saveReview,
  getReview,
  clearReview,
} from "../db.js";

export const SIDES = ["North", "East", "South", "West"];
export const SINGLE_PROBLEM_SIDE = "Problem";

function normalizeSideOrder(sideOrder) {
  const order = Array.isArray(sideOrder)
    ? sideOrder.map((side) => String(side || "").trim()).filter(Boolean)
    : [];
  return order.length ? [...new Set(order)] : [...SIDES];
}

function normalizeFlowType(flowType) {
  return flowType === "single-problem" ? "single-problem" : "perimeter";
}

function normalizeValidation(validation = {}) {
  return {
    whatYouCanSee: Boolean(validation.whatYouCanSee),
    whereItIs: Boolean(validation.whereItIs),
  };
}

function normalizeDescription(description) {
  if (!description || typeof description !== "object") return null;
  const text = String(description.text || "").trim();
  if (!text) return null;
  const source = ["typed", "transcribed", "mixed"].includes(description.source)
    ? description.source
    : "typed";
  return {
    kind: "note",
    text,
    source,
    validation: {
      whatYouCanSee: true,
      whereItIs: true,
    },
    validated: true,
  };
}

function createSideState() {
  return {
    items: [],
    skipped: false,
    description: null,
  };
}

function normalizeSideState(sideState = {}) {
  return {
    items: Array.isArray(sideState.items) ? sideState.items : [],
    skipped: Boolean(sideState.skipped),
    description: normalizeDescription(sideState.description),
  };
}

function normalizeCheck(check) {
  if (!check) return null;
  const sideOrder = normalizeSideOrder(check.sideOrder || check.sides?.order);
  const sides = {};
  for (const side of sideOrder) {
    sides[side] = normalizeSideState(check.sides?.[side]);
  }
  return {
    ...check,
    flowType: normalizeFlowType(check.flowType),
    activeSideIndex:
      typeof check.activeSideIndex === "number" ? check.activeSideIndex : null,
    sideOrder,
    sides,
  };
}

function rehydrateDerivedFields(check) {
  if (!check) return null;
  for (const side of check.sideOrder || SIDES) {
    const description = check.sides[side]?.description;
    if (!description) continue;
    description.validation = {
      whatYouCanSee: true,
      whereItIs: true,
    };
    description.validated = true;
  }
  return check;
}

/** @type {null | {id,siteId,window,startedAt,activeSideIndex:number,sides:Record<string,{items:any[],skipped:boolean,description:any}>,status,submittedAt?,expectedArtifacts?:number,pendingStage?:string,flowType?:string,submissionKind?:string}} */
let current = null;
let postDescribeAction = null;
const listeners = new Set();

// Fire-and-forget mirror of the in-memory check to the draft store. Renders read
// the synchronous `current`; persistence catches up in the background.
function persist() {
  if (current) void saveDraft(current);
}

function emit() {
  listeners.forEach((fn) => fn(current));
}

function persistReview() {
  if (current) void saveReview(current);
}

function canMutateCurrentSession(checkId) {
  return !checkId || current?.id === checkId;
}

/** Which cadence window we're in (pilot: fixed thirds of the day). */
function currentWindow() {
  const h = new Date().getHours();
  if (h < 11) return "morning";
  if (h < 15) return "midday";
  return "evening";
}

export function startCheck(siteId) {
  return startFlow(siteId, { flowType: "perimeter", sideOrder: SIDES });
}

export function startProblemReport(siteId) {
  return startFlow(siteId, {
    flowType: "single-problem",
    sideOrder: [SINGLE_PROBLEM_SIDE],
  });
}

function startFlow(siteId, { flowType, sideOrder }) {
  const order = normalizeSideOrder(sideOrder);
  const sides = {};
  for (const s of order) sides[s] = createSideState();
  current = {
    id: newId(),
    siteId,
    flowType,
    window: currentWindow(),
    startedAt: new Date().toISOString(),
    activeSideIndex: 0,
    sideOrder: order,
    sides,
    status: "in-progress",
  };
  persist();
  emit();
  return current;
}

export function getCurrentCheck() {
  return current;
}

export function onCheckSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Hydrate the in-memory check from the persisted draft (after a reload). If a check
 * is already in memory it wins (no clobbering a live walk). Returns the active check
 * or null. Awaited at /check boot and by home to detect a resumable draft.
 */
export async function loadDraft(flowType) {
  const requestedFlow = flowType ? normalizeFlowType(flowType) : null;
  if (
    current &&
    current.status === "in-progress" &&
    (!requestedFlow || current.flowType === requestedFlow)
  ) {
    return current;
  }
  const draft = await getDraft(requestedFlow);
  if (!draft) {
    return requestedFlow ? null : current;
  }
  current = rehydrateDerivedFields(normalizeCheck(draft));
  return current;
}

export function ensureCheck(siteId) {
  return current || startCheck(siteId);
}

export function ensureProblemReport(siteId) {
  return current || startProblemReport(siteId);
}

/**
 * Hydrate the in-memory check from the persisted review store (after a reload of the
 * results screen). Unlike loadDraft this restores a SUBMITTED session — the one that
 * carries the assessment envelope + findings + photos the review screen needs to
 * dispute and mint tasks on Continue. An in-memory check wins (no clobbering). Returns
 * the active check or null.
 */
export async function loadSubmitted() {
  if (current) return current.status === "in-progress" ? null : current;
  const saved = await getReview();
  if (saved) current = saved;
  return current;
}

export function getActiveSideIndex() {
  return current && typeof current.activeSideIndex === "number"
    ? current.activeSideIndex
    : null;
}

export function getSideOrder() {
  return current?.sideOrder || SIDES;
}

export function getFlowType() {
  return current?.flowType || "perimeter";
}

export function isCurrentSession(checkId, flowType) {
  return Boolean(
    current &&
      current.id === checkId &&
      (!flowType || current.flowType === normalizeFlowType(flowType)),
  );
}

export function setActiveSideIndex(index) {
  if (!current) return;
  const sideCount = getSideOrder().length;
  current.activeSideIndex = Math.max(0, Math.min(sideCount - 1, index));
  persist();
  emit();
}

export function setPostDescribeAction(action) {
  postDescribeAction = action;
}

export function consumePostDescribeAction() {
  const action = postDescribeAction;
  postDescribeAction = null;
  return action;
}

export function getSideDescription(side) {
  if (!current) return null;
  return current.sides[side]?.description || null;
}

export function setSideDescription(side, description) {
  if (!current) return null;
  current.sides[side].description = normalizeDescription(description);
  if (current.sides[side].description) {
    current.sides[side].description.validated =
      current.sides[side].description.validation.whatYouCanSee &&
      current.sides[side].description.validation.whereItIs;
  }
  persist();
  emit();
  return current.sides[side].description;
}

export function setSideDescriptionValidation(side, validation) {
  if (!current) return null;
  const description = current.sides[side]?.description;
  if (!description) return null;
  description.validation = normalizeValidation(validation);
  description.validated =
    description.validation.whatYouCanSee && description.validation.whereItIs;
  persist();
  emit();
  return description;
}

/** Add a capture item to a side. `item` = {kind:'photo', dataUrl, ...}. */
export function addItem(side, item) {
  if (!current) return null;
  const sideState = current.sides[side];
  if (!sideState) return null;
  const record = {
    id: newId(),
    side,
    uploadedAt: new Date().toISOString(),
    ...item,
  };
  sideState.items.push(record);
  persist();
  emit();
  return record;
}

export function removeItem(side, itemId) {
  if (!current) return;
  const s = current.sides[side];
  if (!s) return;
  s.items = s.items.filter((i) => i.id !== itemId);
  persist();
  emit();
}

function findSessionItem(side, itemId) {
  const s = current?.sides?.[side];
  if (!s) return null;
  return s.items.find((i) => i.id === itemId) || null;
}

/**
 * Record a photo's eager upload (services/artifact-uploader.js): its bytes are in
 * S3, so stash the artifact coordinates submit needs to register cheaply, and swap
 * the full-res base64 for a thumbnail to bound the draft's size on many-photo walks.
 * No-op if the item was deleted mid-upload.
 * @param {string} side
 * @param {string} itemId
 * @param {{ artifactId: string, s3Key: string, contentType: string, thumbUrl: string }} coords
 */
export function markItemUploaded(
  side,
  itemId,
  { artifactId, s3Key, contentType, thumbUrl },
) {
  const item = findSessionItem(side, itemId);
  if (!item) return null;
  item.upload = { status: "uploaded", artifactId, s3Key, contentType };
  if (thumbUrl) item.dataUrl = thumbUrl;
  persist();
  emit();
  return item;
}

/**
 * Track the in-flight/terminal state of a photo's eager upload without touching its
 * bytes: "uploading" while a presign+PUT attempt runs, "failed" once retries are
 * exhausted. Failed/uploading items keep their full-res dataUrl so submit can still
 * fall back to a full upload. No-op if the item was deleted mid-upload.
 * @param {string} side
 * @param {string} itemId
 * @param {"uploading"|"failed"} status
 */
export function setItemUploadStatus(side, itemId, status) {
  const item = findSessionItem(side, itemId);
  if (!item) return null;
  item.upload = { ...(item.upload || {}), status };
  persist();
  emit();
  return item;
}

/** Mark a side skipped (still counted in the fixed 4). */
export function skipSide(side) {
  if (!current) return;
  current.sides[side].skipped = true;
  persist();
  emit();
}

/** A side is "done" once it has >=1 photo or was skipped. */
export function isSideCovered(side) {
  if (!current) return false;
  const s = current.sides[side];
  return s.skipped || s.items.length > 0 || Boolean(s.description?.validated);
}

export function coveredCount() {
  return getSideOrder().filter(isSideCovered).length;
}

/** Flat list of all capture items across sides, in side order. */
export function allItems() {
  if (!current) return [];
  return getSideOrder().flatMap((s) => current.sides[s].items);
}

/**
 * Flip the walk to "uploading" once the user submits, before network work begins.
 * Draft persistence stays intact until the upload is durably registered so a failed
 * submission can still be resumed after the pending tile is cleared.
 * @param {{ submissionKind?: "check" | "problem_report", checkId?: string }} [opts]
 */
export function markUploading({ submissionKind = "check", checkId } = {}) {
  if (!current || !canMutateCurrentSession(checkId)) return null;
  current.status = "uploading";
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.submissionKind = submissionKind;
  current.pendingStage = "upload";
  delete current.analysisError;
  persistReview();
  emit();
  return current;
}

/**
 * Flip the walk to "analyzing" once the submission is safely registered server-side.
 * The review store keeps this pending state off the draft/resume path while allowing
 * home to show progress and survive a reload.
 * @param {{ submissionKind?: "check" | "problem_report", expectedArtifacts?: number, checkId?: string }} [opts]
 */
export function markAnalyzing({
  submissionKind = "check",
  expectedArtifacts,
  checkId,
} = {}) {
  if (!current || !canMutateCurrentSession(checkId)) return null;
  current.status = "analyzing";
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.submissionKind = submissionKind;
  current.pendingStage = "analyze";
  if (Number.isFinite(expectedArtifacts)) {
    current.expectedArtifacts = expectedArtifacts;
  }
  delete current.analysisError;
  persistReview();
  emit();
  return current;
}

/**
 * Flip the walk to "submitted" and stash what the results screen needs. The
 * `assessment` envelope (from completeCheck) rides along so the review screen can
 * defer task minting to Continue — sending it to evaluate then, with any disputes.
 */
export function markSubmitted(findings, assessment, { checkId } = {}) {
  if (!current || !canMutateCurrentSession(checkId)) return null;
  current.status = "submitted";
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.findings = findings;
  current.assessment = assessment;
  delete current.pendingStage;
  delete current.analysisError;
  // Mirror the submitted session to the `review` store so a reload of the results
  // screen can rehydrate the envelope + findings + photos (loadSubmitted) instead of
  // dropping to the read-only history path where tasks can never mint.
  persistReview();
  emit();
  return current;
}

/**
 * Surface a background analysis failure on the same review-backed session so home
 * can explain why the pending tile did not resolve.
 * @param {string} message
 */
export function markAnalysisFailed(message, { checkId } = {}) {
  if (!current || !canMutateCurrentSession(checkId)) return null;
  current.status = "analysis_failed";
  current.analysisError = message;
  persistReview();
  emit();
  return current;
}

/**
 * Drop only the persisted review-backed submitted/analyzing session. Used when the
 * local pending marker is stale and should no longer override the backend home view.
 */
export async function clearSubmittedSession() {
  if (current && current.status !== "in-progress") {
    current = null;
  }
  await clearReview();
  emit();
}

/**
 * Drop the walk from memory AND both persisted copies (draft + review). Called on
 * submit/discard and on the review screen's Continue.
 */
export function clearCheck() {
  const flowType = current?.flowType;
  current = null;
  postDescribeAction = null;
  void clearDraft(flowType);
  if (flowType) void clearDraft();
  void clearReview();
  emit();
}
