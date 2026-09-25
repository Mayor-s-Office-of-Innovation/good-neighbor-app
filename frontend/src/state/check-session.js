// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  The in-progress check — the walk's working state.

  Held in memory as a module singleton (survives route changes, no reload) AND
  mirrored to IndexedDB (db.js `draft` store) on every mutation, so a walk survives
  reload / app-close and can be resumed from home. On Done the walk goes to the
  backend (services/submit-check.js); history + the last-log summary read it back
  from there (services/api.js), not from any local `checks` store.

  A check is a flat list of evidence items (ADR 0014): every photo or typed
  description lands in `check.items[]` in capture order, and every mutation is
  keyed by the item id alone. Records persisted before Phase 2 of the places
  removal kept items under `places[placeId].items`; `normalizeCheck` flattens
  those on load so a mid-walk device resumes cleanly.

  The item API stays kind-agnostic on purpose ({kind:'photo', dataUrl} /
  {kind:'text', text}) so post-MVP capture kinds don't require a reshaping.
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

function normalizeFlowType(flowType) {
  return flowType === "single-problem" ? "single-problem" : "perimeter";
}

/**
 * Evidence items of a persisted record, in capture order. A current-shape
 * record carries `items[]`; a pre-Phase-2 record carries `places` +
 * `placeOrder`, whose items are concatenated in place order (then any place
 * missing from the order, so nothing is dropped). Items keep the fields they
 * were written with — an old item's `placeName` still labels its card.
 */
function normalizeItems(check) {
  if (Array.isArray(check.items)) return check.items.filter(Boolean);
  const places =
    check.places && typeof check.places === "object" ? check.places : null;
  if (!places) return [];
  const ordered = Array.isArray(check.placeOrder)
    ? check.placeOrder.map((id) => String(id || "").trim())
    : [];
  const placeIds = [...new Set([...ordered, ...Object.keys(places)])];
  const items = [];
  for (const placeId of placeIds) {
    const placeItems = places[placeId]?.items;
    if (!Array.isArray(placeItems)) continue;
    for (const item of placeItems) if (item) items.push(item);
  }
  return items;
}

/**
 * Coerce a persisted draft/review record to the current shape: flatten a
 * pre-Phase-2 `places` map into `items[]` and drop the retired container
 * fields. Idempotent on a current-shape record.
 */
function normalizeCheck(check) {
  if (!check) return null;
  // eslint-disable-next-line no-unused-vars -- retired fields, dropped on purpose
  const { places, placeOrder, activePlaceIndex, ...rest } = check;
  return {
    ...rest,
    flowType: normalizeFlowType(check.flowType),
    items: normalizeItems(check),
    analyzingOpen: Boolean(check.analyzingOpen),
  };
}

/** @type {null | {id,siteId,window,startedAt,items:any[],status,submittedAt?,expectedArtifacts?:number,flowType?:string,submissionKind?:string,assessment?:any}} */
let current = null;
const listeners = new Set();

// Fire-and-forget mirror of the in-memory check to the draft store. Renders read
// the synchronous `current`; persistence catches up in the background.
function persist() {
  if (!current) return;
  if (current.status === "in-progress") {
    void saveDraft(current);
  } else {
    void saveReview(current);
  }
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

/**
 * Start a perimeter check.
 * @param {string} siteId
 */
export function startCheck(siteId) {
  return startFlow(siteId, "perimeter");
}

export function startProblemReport(siteId) {
  return startFlow(siteId, "single-problem");
}

function startFlow(siteId, flowType) {
  current = {
    id: newId(),
    siteId,
    flowType,
    window: currentWindow(),
    startedAt: new Date().toISOString(),
    items: [],
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
  current = normalizeCheck(draft);
  return current;
}

export async function hasDraft(flowType) {
  const requestedFlow = normalizeFlowType(flowType);
  if (current?.status === "in-progress" && current.flowType === requestedFlow) {
    return true;
  }
  return Boolean(await getDraft(requestedFlow));
}

export async function resumeOrStartCheck(siteId) {
  return (await loadDraft("perimeter")) || startCheck(siteId);
}

export async function resumeOrStartProblemReport(siteId) {
  return (await loadDraft("single-problem")) || startProblemReport(siteId);
}

export function ensureCheck(siteId) {
  return current?.status === "in-progress" && current.flowType === "perimeter"
    ? current
    : startCheck(siteId);
}

export function ensureProblemReport(siteId) {
  return current?.status === "in-progress" &&
    current.flowType === "single-problem"
    ? current
    : startProblemReport(siteId);
}

/**
 * Hydrate the in-memory check from the persisted review store (after a reload —
 * home re-kicks the background scorecard finalization for a capture-complete
 * session). Unlike loadDraft this restores a non-in-progress session. An
 * in-memory check wins (no clobbering). Returns the active check or null.
 */
export async function loadSubmitted() {
  if (current) return current.status === "in-progress" ? null : current;
  const saved = await getReview();
  if (saved) current = normalizeCheck(saved);
  return current;
}

/** Every evidence item in the check, in capture order. */
export function getItems() {
  return current?.items || [];
}

/** One evidence item by id, or null. */
export function findItem(itemId) {
  return getItems().find((item) => item.id === itemId) || null;
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

export function getAnalyzingOpen() {
  return Boolean(current?.analyzingOpen);
}

export function setAnalyzingOpen(open) {
  if (!current) return;
  current.analyzingOpen = Boolean(open);
  persist();
  emit();
}

/** Add a capture item. `item` = {kind:'photo', dataUrl} or {kind:'text', text}. */
export function addItem(item) {
  if (!current) return null;
  const record = {
    id: newId(),
    checkId: current.id,
    uploadedAt: new Date().toISOString(),
    analysis: { status: "idle" },
    ...item,
  };
  current.items.push(record);
  persist();
  emit();
  return record;
}

export function removeItem(itemId) {
  if (!current) return;
  current.items = current.items.filter((i) => i.id !== itemId);
  persist();
  emit();
}

export function updateItem(itemId, patch) {
  const item = findItem(itemId);
  if (!item) return null;
  Object.assign(item, patch);
  persist();
  emit();
  return item;
}

export function updateItemAnalysis(itemId, analysisPatch) {
  const item = findItem(itemId);
  if (!item) return null;
  item.analysis = { ...(item.analysis || {}), ...analysisPatch };
  persist();
  emit();
  return item;
}

/**
 * Capture has ended, but photo/description analysis may still be flowing back
 * into the same session. Keep it review-backed so home can render live results.
 * @param {{ submissionKind?: "check" | "problem_report", checkId?: string, expectedArtifacts?: number }} [opts]
 */
export function markCaptureComplete({
  submissionKind = "check",
  checkId,
  expectedArtifacts,
} = {}) {
  if (!current || !canMutateCurrentSession(checkId)) return null;
  current.status = "capture-complete";
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.submissionKind = submissionKind;
  if (typeof expectedArtifacts === "number") {
    current.expectedArtifacts = expectedArtifacts;
  }
  persistReview();
  void clearDraft({ flowType: current.flowType, siteId: current.siteId });
  emit();
  return current;
}

/**
 * Drop only the persisted review-backed session. Used when the local pending
 * marker is stale and should no longer override the backend home view.
 */
export async function clearSubmittedSession() {
  const siteId = current?.siteId;
  if (current && current.status !== "in-progress") {
    current = null;
  }
  await clearReview(siteId);
  emit();
}

/**
 * Drop the walk from memory AND both persisted copies (draft + review). Called on
 * submit/discard and on the review screen's Continue.
 */
export function clearCheck() {
  const flowType = current?.flowType;
  const siteId = current?.siteId;
  current = null;
  void clearDraft({ flowType, siteId });
  if (flowType) void clearDraft({ siteId });
  void clearReview(siteId);
  emit();
}

/**
 * Drop the in-memory session without touching persisted stores. Used for
 * site switching after pauseCheck() saves the active site's draft, and for
 * sign-out recovery after clearSiteSession() clears all local records.
 */
export function discardInMemorySession() {
  current = null;
  emit();
}

export async function pauseCheck() {
  if (current?.status === "in-progress") {
    await saveDraft(current);
  } else {
    persist();
  }
  current = null;
  emit();
}
