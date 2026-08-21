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
import { newId, saveDraft, clearDraft, getDraft } from "../db.js";

export const SIDES = ["North", "East", "South", "West"];

function createSideState() {
  return {
    items: [],
    skipped: false,
    description: null,
  };
}

/** @type {null | {id,siteId,window,startedAt,activeSideIndex:number,sides:Record<string,{items:any[],skipped:boolean,description:any}>,status,submittedAt?}} */
let current = null;

// Fire-and-forget mirror of the in-memory check to the draft store. Renders read
// the synchronous `current`; persistence catches up in the background.
function persist() {
  if (current) void saveDraft(current);
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
  return current;
}

export function getCurrentCheck() {
  return current;
}

/**
 * Hydrate the in-memory check from the persisted draft (after a reload). If a check
 * is already in memory it wins (no clobbering a live walk). Returns the active check
 * or null. Awaited at /check boot and by home to detect a resumable draft.
 */
export async function loadDraft() {
  if (current) return current;
  const draft = await getDraft();
  if (draft) current = draft;
  return current;
}

export function ensureCheck(siteId) {
  return current || startCheck(siteId);
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
}

export function getSideDescription(side) {
  if (!current) return null;
  return current.sides[side]?.description || null;
}

export function setSideDescription(side, description) {
  if (!current) return null;
  current.sides[side].description = description;
  persist();
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
  return record;
}

export function removeItem(side, itemId) {
  if (!current) return;
  const s = current.sides[side];
  s.items = s.items.filter((i) => i.id !== itemId);
  persist();
}

/** Mark a side skipped (still counted in the fixed 4). */
export function skipSide(side) {
  if (!current) return;
  current.sides[side].skipped = true;
  persist();
}

/** A side is "done" once it has >=1 photo or was skipped. */
export function isSideCovered(side) {
  if (!current) return false;
  const s = current.sides[side];
  return s.skipped || s.items.length > 0;
}

export function coveredCount() {
  return SIDES.filter(isSideCovered).length;
}

/** Flat list of all capture items across sides, in side order. */
export function allItems() {
  if (!current) return [];
  return SIDES.flatMap((s) => current.sides[s].items);
}

export function markSubmitted(findings) {
  if (!current) return null;
  current.status = "submitted";
  current.submittedAt = new Date().toISOString();
  current.findings = findings;
  return current;
}

/** Drop the walk from memory AND the persisted draft (submit or discard). */
export function clearCheck() {
  current = null;
  void clearDraft();
}
