// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  The in-progress perimeter check — held in memory for the duration of a walk.

  Deliberately light (docs/take5-plan.md: "just enough local state to move a check
  through the flow"). It survives hash-route changes (no reload) as a module
  singleton; only the SUBMITTED check is persisted (via db.addCheck) so 5b/history
  and the streak have something real to read. The normalized item/finding stores
  arrive at migration.

  A check has four fixed sides (N/E/S/W). Each side can be covered by any mix of
  photo / voice / note items, or marked "not applicable" (excluded from coverage).
*/
import { newId } from "../db.js";

export const SIDES = ["North", "East", "South", "West"];

/** @type {null | {id,siteId,window,startedAt,sides:Record<string,{items:any[],applicable:boolean}>,status,submittedAt?}} */
let current = null;

/** Which cadence window we're in (pilot: fixed thirds of the day). */
function currentWindow() {
  const h = new Date().getHours();
  if (h < 11) return "morning";
  if (h < 15) return "midday";
  return "evening";
}

export function startCheck(siteId) {
  const sides = {};
  for (const s of SIDES) sides[s] = { items: [], applicable: true };
  current = {
    id: newId(),
    siteId,
    window: currentWindow(),
    startedAt: new Date().toISOString(),
    sides,
    status: "in-progress",
  };
  return current;
}

export function getCurrentCheck() {
  return current;
}

export function ensureCheck(siteId) {
  return current || startCheck(siteId);
}

/** Add a capture item to a side. `item` = {kind:'photo'|'voice'|'note', ...}. */
export function addItem(side, item) {
  if (!current) return null;
  const record = {
    id: newId(),
    side,
    uploadedAt: new Date().toISOString(),
    ...item,
  };
  current.sides[side].items.push(record);
  return record;
}

export function removeItem(side, itemId) {
  if (!current) return;
  const s = current.sides[side];
  s.items = s.items.filter((i) => i.id !== itemId);
}

export function setSideApplicable(side, applicable) {
  if (!current) return;
  current.sides[side].applicable = applicable;
}

/** A side counts as covered if it has >=1 item or is marked not-applicable. */
export function isSideCovered(side) {
  if (!current) return false;
  const s = current.sides[side];
  return !s.applicable || s.items.length > 0;
}

export function coveredCount() {
  return SIDES.filter(isSideCovered).length;
}

export function applicableSides() {
  return SIDES.filter((s) => current && current.sides[s].applicable);
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

export function clearCheck() {
  current = null;
}
