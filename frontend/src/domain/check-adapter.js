/*
  check-adapter — map the backend's DynamoDB item shapes onto the UI's check model,
  so the read screens (today-view) render backend data with minimal change.

  The backend split the old single scorecard into item types:
    - CHECK# header  : { checkId, status:"in_progress"|"completed", startedAt,
                         completedAt, grade, categories:[{category,maxRating,
                         sourceArtifactIds}], issueCount, maxSeverity }
    - ANALYSIS# item : per-artifact adapted assessment — carries `placeName` + the rich
                       `concerns:[{category, rating, explanation, evidenceIndices}]`
    - TASK# item     : the escalation/worklist routing (city vs on-site)

  today-view reads headers only (listChecks) — the last-log line keys off
  `submittedAt` + status; the grade/summary rollup is not currently rendered
  (see the retirement plan's write-only follow-on note).
*/

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
 * Adapt a CHECK# header (from listChecks) into a UI check record.
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
    // Analyzer-sourced one-line overall summary, synthesized onto the header at
    // complete-time. Absent on checks completed before that change -> "".
    summary: header.summary || "",
    issueCount: header.issueCount ?? 0,
    maxSeverity: header.maxSeverity ?? 0,
  };
}
