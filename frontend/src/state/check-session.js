// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  The in-progress perimeter check — the walk's working state.

  Held in memory as a module singleton (survives hash-route changes, no reload) AND
  mirrored to IndexedDB (db.js `draft` store) on every mutation, so a walk survives
  reload / app-close and can be resumed from home. On submit the walk goes to the
  backend (services/submit-check.js); history + the last-log summary read it back
  from there (services/api.js), not from any local `checks` store.

  A perimeter check walks the site's configured places in order. Each place is
  covered by photo captures or marked "skipped". The item API stays kind-agnostic on purpose
  ({kind:'photo', dataUrl}) so post-MVP capture kinds don't require a reshaping. Voice
  capture was removed (native keyboard dictation on the describe screen covers it).
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

export const SINGLE_PROBLEM_PLACE = { id: "problem", name: "Problem" };

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
  // Voice capture is removed (ADR 0009): everything is typed now, so legacy
  // "transcribed"/"mixed" sources coerce to "typed" on load.
  return {
    kind: "note",
    text,
    source: "typed",
    validation: {
      whatYouCanSee: true,
      whereItIs: true,
    },
    validated: true,
  };
}

function createPlaceState(place) {
  return {
    id: place.id,
    name: place.name,
    items: [],
    skipped: false,
    inputMode: "photo",
    draftText: "",
    conditionLabels: [],
    description: null,
  };
}

function normalizePlaceState(place, placeState = {}) {
  return {
    id: place.id,
    name: place.name,
    items: Array.isArray(placeState.items) ? placeState.items : [],
    skipped: Boolean(placeState.skipped),
    inputMode: placeState.inputMode === "text" ? "text" : "photo",
    draftText:
      typeof placeState.draftText === "string" ? placeState.draftText : "",
    conditionLabels: Array.isArray(placeState.conditionLabels)
      ? placeState.conditionLabels.filter((label) => typeof label === "string")
      : [],
    description: normalizeDescription(placeState.description),
  };
}

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
    activePlaceIndex:
      typeof check.activePlaceIndex === "number"
        ? check.activePlaceIndex
        : null,
    placeOrder,
    places,
    analyzingOpen: Boolean(check.analyzingOpen),
    openPhotoMenuItemId:
      typeof check.openPhotoMenuItemId === "string"
        ? check.openPhotoMenuItemId
        : null,
  };
}

function rehydrateDerivedFields(check) {
  if (!check) return null;
  for (const placeId of check.placeOrder || []) {
    const description = check.places[placeId]?.description;
    if (!description) continue;
    description.validation = {
      whatYouCanSee: true,
      whereItIs: true,
    };
    description.validated = true;
  }
  return check;
}

/** @type {null | {id,siteId,window,startedAt,activePlaceIndex:number,placeOrder:string[],places:Record<string,{id:string,name:string,items:any[],skipped:boolean,description:any}>,status,submittedAt?,expectedArtifacts?:number,flowType?:string,submissionKind?:string,assessment?:any}} */
let current = null;
let postDescribeAction = null;
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

export function startCheck(siteId, places = []) {
  return startFlow(siteId, {
    flowType: "perimeter",
    places: normalizePlacesList(places),
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
    activePlaceIndex: 0,
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
  current = rehydrateDerivedFields(normalizeCheck(draft));
  return current;
}

export async function hasDraft(flowType) {
  const requestedFlow = normalizeFlowType(flowType);
  if (current?.status === "in-progress" && current.flowType === requestedFlow) {
    return true;
  }
  return Boolean(await getDraft(requestedFlow));
}

export async function resumeOrStartCheck(siteId, places = []) {
  return (await loadDraft("perimeter")) || startCheck(siteId, places);
}

export async function resumeOrStartProblemReport(siteId) {
  return (await loadDraft("single-problem")) || startProblemReport(siteId);
}

export function ensureCheck(siteId, places = []) {
  return current?.status === "in-progress" && current.flowType === "perimeter"
    ? current
    : startCheck(siteId, places);
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

export function getActivePlaceIndex() {
  return current && typeof current.activePlaceIndex === "number"
    ? current.activePlaceIndex
    : null;
}

export function getPlaceOrder() {
  return current?.placeOrder || [];
}

export function getPlace(placeId) {
  return current?.places?.[placeId] || null;
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

export function setActivePlaceIndex(index) {
  if (!current) return;
  if (index === null) {
    current.activePlaceIndex = null;
    persist();
    emit();
    return;
  }
  const placeCount = getPlaceOrder().length;
  current.activePlaceIndex = Math.max(0, Math.min(placeCount - 1, index));
  persist();
  emit();
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

export function getOpenPhotoMenuItemId() {
  return current?.openPhotoMenuItemId || null;
}

export function setOpenPhotoMenuItemId(itemId) {
  if (!current) return;
  current.openPhotoMenuItemId =
    typeof itemId === "string" && itemId ? itemId : null;
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

export function getPlaceDescription(placeId) {
  if (!current) return null;
  return current.places[placeId]?.description || null;
}

export function setPlaceDescription(placeId, description) {
  if (!current) return null;
  current.places[placeId].description = normalizeDescription(description);
  if (current.places[placeId].description) {
    current.places[placeId].description.validated =
      current.places[placeId].description.validation.whatYouCanSee &&
      current.places[placeId].description.validation.whereItIs;
  }
  persist();
  emit();
  return current.places[placeId].description;
}

export function setPlaceInputMode(placeId, inputMode) {
  if (!current) return null;
  const place = current.places[placeId];
  if (!place) return null;
  place.inputMode = inputMode === "text" ? "text" : "photo";
  persist();
  emit();
  return place;
}

export function setPlaceDraftText(placeId, text, { emitChange = false } = {}) {
  if (!current) return null;
  const place = current.places[placeId];
  if (!place) return null;
  place.draftText = String(text || "");
  persist();
  if (emitChange) emit();
  return place;
}

export function setPlaceDescriptionValidation(placeId, validation) {
  if (!current) return null;
  const description = current.places[placeId]?.description;
  if (!description) return null;
  description.validation = normalizeValidation(validation);
  description.validated =
    description.validation.whatYouCanSee && description.validation.whereItIs;
  persist();
  emit();
  return description;
}

/** Add a capture item to a place. `item` = {kind:'photo', dataUrl, ...}. */
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
  placeState.skipped = false;
  persist();
  emit();
  return record;
}

export function addPlaceToCheck(name) {
  if (!current) return null;
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;
  const duplicate = getPlaceOrder().some((placeId) => {
    const existing = current.places[placeId]?.name || "";
    return existing.trim().toLowerCase() === normalizedName.toLowerCase();
  });
  if (duplicate) return { duplicate: true };
  const baseId = normalizedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  let id = baseId || `place-${current.placeOrder.length + 1}`;
  let suffix = 2;
  while (current.places[id]) id = `${baseId}-${suffix++}`;
  const place = { id, name: normalizedName, order: current.placeOrder.length };
  current.placeOrder.push(id);
  current.places[id] = createPlaceState(place);
  current.activePlaceIndex = current.placeOrder.length - 1;
  persist();
  emit();
  return current.places[id];
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
  const place = current?.places?.[placeId];
  if (place) {
    const labels = new Set();
    for (const placeItem of place.items || []) {
      const hiddenConditionIds = new Set([
        ...(placeItem.analysis?.resolvedConditionIds || []),
        ...(placeItem.analysis?.rejectedConditionIds || []),
      ]);
      for (const condition of placeItem.analysis?.conditions || []) {
        if (hiddenConditionIds.has(condition?.conditionId)) continue;
        const label =
          condition?.category ||
          condition?.analyzerCategory ||
          condition?.canonicalCategory ||
          condition?.label;
        if (typeof label === "string" && label.trim()) labels.add(label.trim());
      }
    }
    place.conditionLabels = [...labels];
  }
  persist();
  emit();
  return item;
}

/** Mark a place skipped. */
export function skipPlace(placeId) {
  if (!current) return;
  current.places[placeId].skipped = true;
  persist();
  emit();
}

/** A place is "done" once it has >=1 photo, a description, or was skipped. */
export function isPlaceCovered(placeId) {
  if (!current) return false;
  const place = current.places[placeId];
  return (
    place.skipped ||
    place.items.length > 0 ||
    Boolean(place.description?.validated)
  );
}

export function coveredCount() {
  return getPlaceOrder().filter(isPlaceCovered).length;
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
  postDescribeAction = null;
  void clearDraft(flowType);
  if (flowType) void clearDraft();
  void clearReview();
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
