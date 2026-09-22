// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  The in-progress check — the walk's working state.

  Held in memory as a module singleton (survives route changes, no reload) AND
  mirrored to IndexedDB (db.js `draft` store) on every mutation, so a walk survives
  reload / app-close and can be resumed from home. On Done the walk goes to the
  backend (services/submit-check.js); history + the last-log summary read it back
  from there (services/api.js), not from any local `checks` store.

  Phase 1 of docs/plan-remove-places.md: a perimeter check no longer walks a
  list of configured places. Every capture lands under ONE synthetic place
  (named after the site) so the per-item pipeline, result cards, and backend
  keys keep working unchanged. The single-issue flow already worked this way
  (SINGLE_PROBLEM_PLACE). Phase 2 flattens the place layer away entirely; until
  then `check.places[placeId].items` is the storage shape and
  domain/check-completion.js reads across it.

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

export const PERIMETER_PLACE_ID = "perimeter";
export const SINGLE_PROBLEM_PLACE = { id: "problem", name: "Problem" };

/**
 * The one synthetic place a perimeter check captures into. Its name is the
 * site name: it rides along as `placeName` on every artifact and becomes the
 * analyzer's position descriptor + the evidence label on result cards.
 * @param {string | null | undefined} siteName
 */
export function perimeterPlace(siteName) {
  const name = String(siteName || "").trim();
  return { id: PERIMETER_PLACE_ID, name: name || "Perimeter" };
}

function normalizePlacesList(places) {
  const source = Array.isArray(places) ? places : [];
  const normalized = [];
  const seen = new Set();
  for (const raw of source) {
    const id =
      raw && typeof raw === "object"
        ? String(raw.id || "").trim()
        : String(raw || "").trim();
    const name =
      raw && typeof raw === "object"
        ? String(raw.name || "").trim()
        : String(raw || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, name, order: normalized.length });
  }
  return normalized;
}

function normalizePlaceOrder(placeOrder, places) {
  const byId = new Set((places || []).map((place) => place.id));
  const order = Array.isArray(placeOrder)
    ? placeOrder
        .map((placeId) => String(placeId || "").trim())
        .filter((placeId) => byId.has(placeId))
    : [];
  return order.length ? [...new Set(order)] : (places || []).map((p) => p.id);
}

function normalizeFlowType(flowType) {
  return flowType === "single-problem" ? "single-problem" : "perimeter";
}

function createPlaceState(place) {
  return { id: place.id, name: place.name, items: [] };
}

function normalizePlaceState(place, placeState = {}) {
  return {
    id: place.id,
    name: place.name,
    items: Array.isArray(placeState.items) ? placeState.items : [],
  };
}

/**
 * Coerce a persisted draft/review record to the current shape. Drafts written
 * before the places removal may carry several named places plus per-place
 * text-mode fields; the places (and their items) survive so a mid-walk device
 * resumes cleanly, and the retired fields are simply dropped.
 */
function normalizeCheck(check) {
  if (!check) return null;
  const placesList = normalizePlacesList(
    check.placeList ||
      check.placesList ||
      (check.places && typeof check.places === "object"
        ? Object.values(check.places)
        : []),
  );
  const placeOrder = normalizePlaceOrder(
    check.placeOrder || check.places?.order,
    placesList,
  );
  const places = {};
  for (const placeId of placeOrder) {
    const place = placesList.find((p) => p.id === placeId) || {
      id: placeId,
      name: placeId,
    };
    places[placeId] = normalizePlaceState(place, check.places?.[placeId]);
  }
  return {
    ...check,
    flowType: normalizeFlowType(check.flowType),
    placeOrder,
    places,
    analyzingOpen: Boolean(check.analyzingOpen),
  };
}

/** @type {null | {id,siteId,window,startedAt,placeOrder:string[],places:Record<string,{id:string,name:string,items:any[]}>,status,submittedAt?,expectedArtifacts?:number,flowType?:string,submissionKind?:string,assessment?:any}} */
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
 * Start a perimeter check. Captures land under the one synthetic place.
 * @param {string} siteId
 * @param {string} [siteName]
 */
export function startCheck(siteId, siteName) {
  return startFlow(siteId, {
    flowType: "perimeter",
    places: [perimeterPlace(siteName)],
  });
}

export function startProblemReport(siteId) {
  return startFlow(siteId, {
    flowType: "single-problem",
    places: [SINGLE_PROBLEM_PLACE],
  });
}

function startFlow(siteId, { flowType, places: configuredPlaces }) {
  const placeList = normalizePlacesList(configuredPlaces);
  const placeOrder = placeList.map((place) => place.id);
  const places = {};
  for (const place of placeList) places[place.id] = createPlaceState(place);
  current = {
    id: newId(),
    siteId,
    flowType,
    window: currentWindow(),
    startedAt: new Date().toISOString(),
    placeOrder,
    places,
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

export async function resumeOrStartCheck(siteId, siteName) {
  return (await loadDraft("perimeter")) || startCheck(siteId, siteName);
}

export async function resumeOrStartProblemReport(siteId) {
  return (await loadDraft("single-problem")) || startProblemReport(siteId);
}

export function ensureCheck(siteId, siteName) {
  return current?.status === "in-progress" && current.flowType === "perimeter"
    ? current
    : startCheck(siteId, siteName);
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
  if (saved) current = saved;
  return current;
}

export function getPlaceOrder() {
  return current?.placeOrder || [];
}

export function getPlace(placeId) {
  return current?.places?.[placeId] || null;
}

/**
 * The place new captures go to. One synthetic place for new checks; the first
 * place of a pre-removal draft that is still being walked.
 */
export function getCapturePlaceId() {
  return getPlaceOrder()[0] || null;
}

/** Every evidence item in the check, in capture order. */
export function getItems() {
  if (!current) return [];
  return getPlaceOrder().flatMap(
    (placeId) => current.places?.[placeId]?.items || [],
  );
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
export function addItem(placeId, item) {
  if (!current) return null;
  const placeState = current.places[placeId];
  if (!placeState) return null;
  const record = {
    id: newId(),
    checkId: current.id,
    placeId,
    placeName: placeState.name,
    uploadedAt: new Date().toISOString(),
    analysis: { status: "idle" },
    ...item,
  };
  placeState.items.push(record);
  persist();
  emit();
  return record;
}

export function removeItem(placeId, itemId) {
  if (!current) return;
  const place = current.places[placeId];
  if (!place) return;
  place.items = place.items.filter((i) => i.id !== itemId);
  persist();
  emit();
}

function findSessionItem(placeId, itemId) {
  const place = current?.places?.[placeId];
  if (!place) return null;
  return place.items.find((i) => i.id === itemId) || null;
}

export function updateItem(placeId, itemId, patch) {
  const item = findSessionItem(placeId, itemId);
  if (!item) return null;
  Object.assign(item, patch);
  persist();
  emit();
  return item;
}

export function updateItemAnalysis(placeId, itemId, analysisPatch) {
  const item = findSessionItem(placeId, itemId);
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
  void clearDraft(current.flowType);
  emit();
  return current;
}

/**
 * Drop only the persisted review-backed session. Used when the local pending
 * marker is stale and should no longer override the backend home view.
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
  void clearDraft(flowType);
  if (flowType) void clearDraft();
  void clearReview();
  emit();
}

/**
 * Drop the in-memory session without touching persisted stores (db.js does
 * the store clears). Used on sign-out recovery, where clearSiteSession()
 * clears draft+review wholesale and any in-memory `current` would otherwise
 * survive as a stale singleton from the previous site.
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
