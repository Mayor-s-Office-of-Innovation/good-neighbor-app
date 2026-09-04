/*
  check-adapter — map the backend's DynamoDB item shapes onto the UI's check +
  findings model, so the read screens (today-view, check-results) render backend
  data with minimal change.

  The backend split the old single scorecard into three item types:
    - CHECK# header  : { checkId, status:"in_progress"|"completed", startedAt,
                         completedAt, grade, categories:[{category,maxRating,
                         sourceArtifactIds}], issueCount, maxSeverity }
    - ANALYSIS# item : per-artifact adapted assessment — carries `placeName` + the rich
                       `concerns:[{category, rating, explanation, evidenceIndices}]`
    - TASK# item     : the escalation/worklist routing (city vs on-site)

  The UI's "finding" is `{ category, rating, severity, hazard, explanation, placeName,
  sourceKind }`. `hazard` and `explanation` are NOT on the header — hazard moved
  into task routing and explanation lives on the per-artifact concerns — so:
    - detail reads (getCheck) build rich findings from ANALYSIS# concerns.
    - list reads (listChecks, headers only) build lite findings from the header's
      category rollup (no explanation/place) — enough for the donut + last-log.

  HAZARD ("city action") is read from the authoritative TASK# items, never derived
  here. The backend stamps each task's `type` at creation (backend/src/analysis/
  task-routing.js) — `city_escalation` vs `onsite` — so callers fetch the site's
  tasks (listTasks), reduce them to the set of city-escalation category names per
  check via `cityCategoriesByCheck`/`cityCategoriesForCheck`, and pass that set in.
  A finding is a "city action" iff its category is in that set. This keeps the
  worklist + results buckets in lockstep with the tasks the backend actually minted
  (no client-side copy of the escalation rule to drift).
*/
import { severityWord } from "../config/scorecard.js";

/**
 * Reduce a site's TASK# items to the city-escalation category names per check.
 * The backend classifies each task once at creation (task-routing.js), so this is
 * the source of truth for "which findings are the city's to handle" — read it
 * instead of re-deriving the escalation rule client-side.
 * @param {any[]} [tasks]  TASK# items (from listTasks)
 * @returns {Map<string, Set<string>>}  checkId -> set of escalated category names
 */
export function cityCategoriesByCheck(tasks = []) {
  /** @type {Map<string, Set<string>>} */
  const byCheck = new Map();
  for (const t of tasks) {
    if (t.type !== "city_escalation") continue;
    let set = byCheck.get(t.checkId);
    if (!set) byCheck.set(t.checkId, (set = new Set()));
    set.add(t.category);
  }
  return byCheck;
}

/**
 * The city-escalation category names for a single check.
 * @param {any[]} tasks  TASK# items (from listTasks)
 * @param {string} checkId
 * @returns {Set<string>}
 */
export function cityCategoriesForCheck(tasks, checkId) {
  return cityCategoriesByCheck(tasks).get(checkId) || new Set();
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
 * artifact's place.
 * @param {any[]} analyses  ANALYSIS# items from getCheck
 * @param {Set<string>} [cityCategories]  escalated category names for this check
 * @returns {Array<object>}
 */
export function analysesToFindings(analyses = [], cityCategories = new Set()) {
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
        hazard: cityCategories.has(c.category),
        explanation: c.explanation || "",
        placeId: a.placeId || null,
        placeName: a.placeName || null,
        sourceKind: "photo",
        evidenceIndices: c.evidenceIndices || [],
      });
    }
  }
  return findings;
}

/**
 * Lite findings from a CHECK# header's category rollup (the list read — headers
 * carry no explanation or place). Enough for today-view's donut + last-log.
 * @param {any} header
 * @param {Set<string>} [cityCategories]  escalated category names for this check
 * @returns {Array<object>}
 */
export function headerToFindings(header, cityCategories = new Set()) {
  return (header.categories || [])
    .filter((c) => (c.maxRating || 0) >= 1)
    .map((c) => ({
      category: c.category,
      rating: c.maxRating,
      severity: severityWord(c.maxRating),
      hazard: cityCategories.has(c.category),
      explanation: "",
      placeId: null,
      placeName: null,
      sourceKind: null,
    }));
}

/**
 * Adapt a CHECK# header (from listChecks) into a UI check record shaped like the
 * pre-cutover local record, with lite header-derived findings.
 * @param {any} header
 * @param {Set<string>} [cityCategories]  escalated category names for this check
 * @returns {object}
 */
export function adaptCheckHeader(header, cityCategories = new Set()) {
  return {
    id: header.checkId,
    status: uiStatus(header.status),
    submittedAt: occurredAt(header),
    startedAt: header.startedAt || null,
    grade: header.grade ?? null,
    // Analyzer-sourced one-line overall summary, synthesized onto the header at
    // complete-time. Absent on checks completed before that change -> "".
    summary: header.summary || "",
    issueCount: header.issueCount ?? 0,
    maxSeverity: header.maxSeverity ?? 0,
    findings: headerToFindings(header, cityCategories),
  };
}

/**
 * Adapt a getCheck detail payload ({ check, artifacts, analyses }) into a UI check
 * record with rich per-artifact findings.
 * @param {{ check: any, artifacts?: any[], analyses?: any[] }} detail
 * @param {Set<string>} [cityCategories]  escalated category names for this check
 * @returns {object}
 */
export function adaptCheckDetail(
  { check, analyses = [] },
  cityCategories = new Set(),
) {
  return {
    id: check.checkId,
    status: uiStatus(check.status),
    submittedAt: occurredAt(check),
    startedAt: check.startedAt || null,
    grade: check.grade ?? null,
    // Analyzer-sourced one-line overall summary (worst-artifact synthesis),
    // persisted onto the header at complete-time. "" when absent (older checks /
    // synthesis gap) — the results screen renders an explicit "summary missing".
    summary: check.summary || "",
    issueCount: check.issueCount ?? 0,
    maxSeverity: check.maxSeverity ?? 0,
    findings: analysesToFindings(analyses, cityCategories),
  };
}
