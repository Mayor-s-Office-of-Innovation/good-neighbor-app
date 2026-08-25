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
  const sides = {};
  for (const side of SIDES) {
    sides[side] = normalizeSideState(check.sides?.[side]);
  }
  return {
    ...check,
    activeSideIndex:
      typeof check.activeSideIndex === "number" ? check.activeSideIndex : null,
    sides,
  };
}

function rehydrateDerivedFields(check) {
  if (!check) return null;
  for (const side of SIDES) {
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

/** @type {null | {id,siteId,window,startedAt,activeSideIndex:number,sides:Record<string,{items:any[],skipped:boolean,description:any}>,status,submittedAt?}} */
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

/** Which cadence window we're in (pilot: fixed thirds of the day). */
function currentWindow() {
  const h = new Date().getHours();
  if (h < 11) return "morning";
  if (h < 15) return "midday";
  return "evening";
}

export function startCheck(siteId) {
  const sides = {};
  for (const s of SIDES) sides[s] = createSideState();
  current = {
    id: newId(),
    siteId,
    window: currentWindow(),
    startedAt: new Date().toISOString(),
    activeSideIndex: 0,
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
export async function loadDraft() {
  if (current) return current;
  const draft = await getDraft();
  if (draft) current = rehydrateDerivedFields(normalizeCheck(draft));
  return current;
}

export function ensureCheck(siteId) {
  return current || startCheck(siteId);
}

/**
 * Hydrate the in-memory check from the persisted review store (after a reload of the
 * results screen). Unlike loadDraft this restores a SUBMITTED session — the one that
 * carries the assessment envelope + findings + photos the review screen needs to
 * dispute and mint tasks on Continue. An in-memory check wins (no clobbering). Returns
 * the active check or null.
 */
export async function loadSubmitted() {
  if (current && current.status !== "in-progress") return current;
  const saved = await getReview();
  if (saved) current = saved;
  return current;
}

export function getActiveSideIndex() {
  return current && typeof current.activeSideIndex === "number"
    ? current.activeSideIndex
    : null;
}

export function setActiveSideIndex(index) {
  if (!current) return;
  current.activeSideIndex = Math.max(0, Math.min(SIDES.length - 1, index));
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
  const record = {
    id: newId(),
    side,
    uploadedAt: new Date().toISOString(),
    ...item,
  };
  current.sides[side].items.push(record);
  persist();
  emit();
  return record;
}

export function removeItem(side, itemId) {
  if (!current) return;
  const s = current.sides[side];
  s.items = s.items.filter((i) => i.id !== itemId);
  persist();
  emit();
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
  return SIDES.filter(isSideCovered).length;
}

/** Flat list of all capture items across sides, in side order. */
export function allItems() {
  if (!current) return [];
  return SIDES.flatMap((s) => current.sides[s].items);
}

/**
 * Flip the walk to "analyzing" once the submission is safely registered server-side.
 * The review store keeps this pending state off the draft/resume path while allowing
 * home to show progress and survive a reload.
 * @param {{ submissionKind?: "check" | "problem_report" }} [opts]
 */
export function markAnalyzing({ submissionKind = "check" } = {}) {
  if (!current) return null;
  current.status = "analyzing";
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.submissionKind = submissionKind;
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
export function markSubmitted(findings, assessment) {
  if (!current) return null;
  current.status = "submitted";
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.findings = findings;
  current.assessment = assessment;
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
export function markAnalysisFailed(message) {
  if (!current) return null;
  current.status = "analysis_failed";
  current.analysisError = message;
  persistReview();
  emit();
  return current;
}

/**
 * Drop the walk from memory AND both persisted copies (draft + review). Called on
 * submit/discard and on the review screen's Continue.
 */
export function clearCheck() {
  current = null;
  postDescribeAction = null;
  void clearDraft();
  void clearReview();
  emit();
}
