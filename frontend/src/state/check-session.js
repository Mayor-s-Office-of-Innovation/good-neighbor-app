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

  Finished checks: Done keeps the check (status `capture-complete`) until its
  uploads and scorecard land, so several can wait at once when checks are
  finished offline. `current` is the one on screen; the others live in
  `finished`. Item ids are unique across checks, so the item mutators find
  their check by item id and an older check keeps saving its upload/analysis
  progress after a new walk starts (services/check-submissions.js drives them).
*/
import { cancelCheckPolling } from "../services/check-polling.js";
import { completeFirstPerimeterCheck } from "../services/install-prompt.js";
import {
  newId,
  saveDraft,
  clearDraft,
  getDraft,
  saveFinishedCheck,
  listFinishedChecks,
  deleteFinishedCheck,
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

/** @type {null | {id,siteId,window,startedAt,items:any[],status,submittedAt?,expectedArtifacts?:number,flowType?:string,submissionKind?:string,scorecardDone?:boolean,assessment?:any,captureGuidanceContext?:{titleKey:string}}} */
let current = null;
/** Finished checks other than `current`, by check id. */
const finished = new Map();
const listeners = new Set();

// Fire-and-forget mirror of an in-memory check to IndexedDB: the walk to the
// draft store, a finished check to its own record. Renders read the
// synchronous state; persistence catches up in the background.
function persist(check = current) {
  if (!check) return;
  if (check.status === "in-progress") {
    void saveDraft(check);
  } else {
    void saveFinishedCheck(check);
  }
}

/** Listeners receive the check that changed: usually `current`, or a finished one. */
function emit(check = current) {
  listeners.forEach((fn) => fn(check));
}

/** Keep a finished `current` running in the background before replacing it. */
function retireCurrent() {
  if (current && current.status !== "in-progress")
    finished.set(current.id, current);
}

function checkForItem(itemId) {
  if (current?.items?.some((item) => item.id === itemId)) return current;
  for (const check of finished.values())
    if (check.items.some((item) => item.id === itemId)) return check;
  return null;
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
  // Submitted checks still need their background scorecard finalized, even
  // when the user starts another capture before analysis finishes.
  if (current?.status === "in-progress") cancelCheckPolling(current.id);
  retireCurrent();
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

/** Persist the starting title so resuming a check does not change its day/ordinal. */
export function setCaptureGuidanceContext(checkId, context) {
  if (current?.id !== checkId) return;
  current.captureGuidanceContext = context;
  persist();
  emit();
}

export function getCurrentCheck() {
  return current;
}

/** A check held in memory (current or finished) by id, or null. */
export function getCheck(checkId) {
  if (current?.id === checkId) return current;
  return finished.get(checkId) || null;
}

/** The in-memory check (current or finished) that holds an evidence item, or null. */
export function findCheckForItem(itemId) {
  return checkForItem(itemId);
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
  retireCurrent();
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
 * Hydrate every finished check for the site from IndexedDB (after a reload).
 * In-memory copies win (no clobbering a live upload). Returns them oldest
 * first, including a finished `current`.
 * @param {string} [siteId]
 */
export async function loadFinishedChecks(siteId) {
  const owner = siteId || current?.siteId;
  for (const saved of await listFinishedChecks(owner)) {
    if (current?.id === saved.id || finished.has(saved.id)) continue;
    finished.set(saved.id, normalizeCheck(saved));
  }
  return [
    ...finished.values(),
    ...(current && current.status !== "in-progress" ? [current] : []),
  ]
    .filter((check) => !owner || check.siteId === owner)
    .sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""));
}

/**
 * The newest finished check, for home's live results (home re-kicks its
 * background scorecard). With no walk in memory it becomes `current`, as a
 * restored session always has; during a walk it stays in the background.
 * Returns null when nothing is waiting.
 */
export async function loadSubmitted() {
  if (current && current.status !== "in-progress") return current;
  const newest = (await loadFinishedChecks(current?.siteId)).at(-1) || null;
  if (newest && !current) {
    finished.delete(newest.id);
    current = newest;
  }
  return newest;
}

/** Every evidence item in the current check, in capture order. */
export function getItems() {
  return current?.items || [];
}

/** One evidence item by id from any in-memory check, or null. */
export function findItem(itemId) {
  return checkForItem(itemId)?.items.find((item) => item.id === itemId) || null;
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
  const check = checkForItem(itemId) || current;
  if (!check) return;
  check.items = check.items.filter((i) => i.id !== itemId);
  persist(check);
  emit(check);
}

export function updateItem(itemId, patch) {
  const check = checkForItem(itemId);
  const item = findItem(itemId);
  if (!item) return null;
  Object.assign(item, patch);
  persist(check);
  emit(check);
  return item;
}

export function updateItemAnalysis(itemId, analysisPatch) {
  const check = checkForItem(itemId);
  const item = findItem(itemId);
  if (!item) return null;
  item.analysis = { ...(item.analysis || {}), ...analysisPatch };
  persist(check);
  emit(check);
  return item;
}

/**
 * Drop a rejected condition from a session item: its task card goes, and the
 * condition id is remembered so a later analysis refresh does not revive it.
 * No-op (null) when the item is not in the current session.
 * @param {{ itemId?: string, taskId?: string, conditionId?: string }} problem
 */
export function rejectConditionLocally({ itemId, taskId, conditionId }) {
  const item = findItem(itemId || "");
  if (!item) return null;
  return updateItemAnalysis(item.id, {
    tasks: (item.analysis?.tasks || []).filter(
      (task) => task.taskId !== taskId,
    ),
    rejectedConditionIds: [
      ...(item.analysis?.rejectedConditionIds || []),
      conditionId,
    ].filter(Boolean),
  });
}

/**
 * Mark a condition resolved on a session item: its task card goes, and the
 * condition id is remembered as handled. No-op (null) when the item is not
 * in the current session.
 * @param {{ itemId?: string, taskId?: string, conditionId?: string }} problem
 */
export function resolveConditionLocally({ itemId, taskId, conditionId }) {
  const item = findItem(itemId || "");
  if (!item) return null;
  return updateItemAnalysis(item.id, {
    tasks: (item.analysis?.tasks || []).filter(
      (task) => task.taskId !== taskId,
    ),
    resolvedConditionIds: [
      ...(item.analysis?.resolvedConditionIds || []),
      conditionId,
    ].filter(Boolean),
  });
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
  if (current.flowType === "perimeter" && submissionKind === "check")
    completeFirstPerimeterCheck();
  current.submittedAt = current.submittedAt || new Date().toISOString();
  current.submissionKind = submissionKind;
  if (typeof expectedArtifacts === "number") {
    current.expectedArtifacts = expectedArtifacts;
  }
  persist();
  void clearDraft({ flowType: current.flowType, siteId: current.siteId });
  emit();
  return current;
}

/**
 * Record that a finished check's run-level scorecard has landed, so the
 * background sender stops re-running it. The check stays held until home
 * sees it in the backend history (clearSubmittedSession).
 * @param {string} checkId
 */
export function markScorecardDone(checkId) {
  const check = getCheck(checkId);
  if (!check || check.status === "in-progress" || check.scorecardDone) return;
  check.scorecardDone = true;
  persist(check);
}

/**
 * Drop one finished check (default: a finished `current`) from memory and
 * IndexedDB. Used when home sees it superseded by backend history and it
 * should no longer override the backend view.
 * @param {string} [checkId]
 */
export async function clearSubmittedSession(checkId) {
  const id =
    checkId || (current && current.status !== "in-progress" ? current.id : "");
  if (!id) return;
  const check = getCheck(id);
  if (current?.id === id && current.status !== "in-progress") current = null;
  finished.delete(id);
  await deleteFinishedCheck(check?.siteId || current?.siteId || "", id);
  emit();
}

/**
 * Drop the current check from memory AND its persisted copies (draft and
 * finished record). Called on submit/discard and on the review screen's
 * Continue. Other finished checks keep uploading.
 */
export function clearCheck() {
  if (current) cancelCheckPolling(current.id);
  const flowType = current?.flowType;
  const siteId = current?.siteId;
  const checkId = current?.id;
  current = null;
  void clearDraft({ flowType, siteId });
  if (flowType) void clearDraft({ siteId });
  if (checkId) void deleteFinishedCheck(siteId, checkId);
  emit();
}

/**
 * Drop the in-memory checks without touching persisted stores. Used for
 * site switching after pauseCheck() saves the active site's draft, and for
 * sign-out recovery after clearSiteSession() clears all local records.
 */
export function discardInMemorySession() {
  if (current) cancelCheckPolling(current.id);
  for (const id of finished.keys()) cancelCheckPolling(id);
  current = null;
  finished.clear();
  emit();
}

export async function pauseCheck() {
  if (current) cancelCheckPolling(current.id);
  for (const id of finished.keys()) cancelCheckPolling(id);
  if (current?.status === "in-progress") {
    await saveDraft(current);
  } else {
    persist();
  }
  // Finished checks are already persisted; they resume with their own site.
  current = null;
  finished.clear();
  emit();
}
