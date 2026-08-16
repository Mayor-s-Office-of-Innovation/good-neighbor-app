/*
  check-adapter — map the backend's DynamoDB item shapes onto the UI's check +
  findings model, so the read screens (today-view, check-results) render backend
  data with minimal change.

  The backend split the old single scorecard into three item types:
    - CHECK# header  : { checkId, status:"in_progress"|"completed", startedAt,
                         completedAt, grade, categories:[{category,maxRating,
                         sourceArtifactIds}], issueCount, maxSeverity }
    - ANALYSIS# item : per-artifact adapted assessment — carries `side` + the rich
                       `concerns:[{category, rating, explanation, evidenceIndices}]`
    - TASK# item     : the escalation/worklist routing (city vs on-site)

  The UI's "finding" is `{ category, rating, severity, hazard, explanation, side,
  sourceKind }`. `hazard` and `explanation` are NOT on the header — hazard moved
  into task routing and explanation lives on the per-artifact concerns — so:
    - detail reads (getCheck) build rich findings from ANALYSIS# concerns.
    - list reads (listChecks, headers only) build lite findings from the header's
      category rollup (no explanation/side) — enough for the donut + last-log.

  HAZARD is derived here by mirroring the backend's placeholder escalation matrix
  (backend/src/analysis/task-routing.js): a concern is "city action" when its
  category name hints hazardous/toxic material AND its severity ≥ 3. This keeps the
  results screen's city/handle/noted buckets consistent with the tasks the backend
  actually minted. TODO(product): when the real escalation matrix + a tasks-driven
  results view land, read hazard from TASK# items instead of re-deriving it.
*/
import { severityWord } from "../config/scorecard.js";

// Mirror of task-routing.js ESCALATION_HINTS + ESCALATE_MIN_SEVERITY. Kept in
// lockstep with the backend placeholder until the real matrix replaces both.
const ESCALATION_HINTS = [
  "hazard",
  "toxic",
  "biohazard",
  "chemical",
  "needle",
  "syringe",
  "waste",
  "spill",
  "drug",
];
const ESCALATE_MIN_SEVERITY = 3;

/**
 * Would this category+severity escalate to the city (vs. become on-site upkeep)?
 * @param {string} category
 * @param {number} rating
 * @returns {boolean}
 */
function isCityAction(category, rating) {
  if (!rating || rating < ESCALATE_MIN_SEVERITY) return false;
  const name = String(category || "").toLowerCase();
  return ESCALATION_HINTS.some((hint) => name.includes(hint));
}

/**
 * A completed header's UI status. The rest of the app keys off "submitted"
 * (matching the pre-cutover local record); in-progress checks are still walking.
 * @param {string} [status]
 * @returns {"submitted"|"in-progress"}
 */
function uiStatus(status) {
  return status === "completed" ? "submitted" : "in-progress";
}

/** When the check "happened" for display: completion time, else start. */
function occurredAt(header) {
  return header.completedAt || header.synthesizedAt || header.startedAt || null;
}

/**
 * Rich findings from the per-artifact ANALYSIS# items (the detail read). One
 * finding per concern with rating ≥ 1, carrying the concern's explanation and the
 * artifact's side.
 * @param {any[]} analyses  ANALYSIS# items from getCheck
 * @returns {Array<object>}
 */
export function analysesToFindings(analyses = []) {
  /** @type {Array<object>} */
  const findings = [];
  for (const a of analyses) {
    if (a.status && a.status !== "analyzed") continue; // skip failed markers
    for (const c of a.concerns || []) {
      if (!c.rating || c.rating < 1) continue;
      findings.push({
        category: c.category,
        rating: c.rating,
        severity: severityWord(c.rating),
        hazard: isCityAction(c.category, c.rating),
        explanation: c.explanation || "",
        side: a.side || null,
        sourceKind: "photo",
        evidenceIndices: c.evidenceIndices || [],
      });
    }
  }
  return findings;
}

/**
 * Lite findings from a CHECK# header's category rollup (the list read — headers
 * carry no explanation or side). Enough for today-view's donut + last-log.
 * @param {any} header
 * @returns {Array<object>}
 */
export function headerToFindings(header) {
  return (header.categories || [])
    .filter((c) => (c.maxRating || 0) >= 1)
    .map((c) => ({
      category: c.category,
      rating: c.maxRating,
      severity: severityWord(c.maxRating),
      hazard: isCityAction(c.category, c.maxRating),
      explanation: "",
      side: null,
      sourceKind: null,
    }));
}

/**
 * Adapt a CHECK# header (from listChecks) into a UI check record shaped like the
 * pre-cutover local record, with lite header-derived findings.
 * @param {any} header
 * @returns {object}
 */
export function adaptCheckHeader(header) {
  return {
    id: header.checkId,
    status: uiStatus(header.status),
    submittedAt: occurredAt(header),
    startedAt: header.startedAt || null,
    grade: header.grade ?? null,
    issueCount: header.issueCount ?? 0,
    maxSeverity: header.maxSeverity ?? 0,
    findings: headerToFindings(header),
  };
}

/**
 * Adapt a getCheck detail payload ({ check, artifacts, analyses }) into a UI check
 * record with rich per-artifact findings.
 * @param {{ check: any, artifacts?: any[], analyses?: any[] }} detail
 * @returns {object}
 */
export function adaptCheckDetail({ check, analyses = [] }) {
  return {
    id: check.checkId,
    status: uiStatus(check.status),
    submittedAt: occurredAt(check),
    startedAt: check.startedAt || null,
    grade: check.grade ?? null,
    issueCount: check.issueCount ?? 0,
    maxSeverity: check.maxSeverity ?? 0,
    findings: analysesToFindings(analyses),
  };
}
