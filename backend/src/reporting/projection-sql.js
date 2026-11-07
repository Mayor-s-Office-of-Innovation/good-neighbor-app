// The Insights counting rules, run once per snapshot so screens, CSVs and
// reports never recount. Reads the in_* inputs, rule_hours and
// category_names; snapshot_at() is the evaluation time. Every rule judges
// records as of that time, never the reader's clock.

import { PACIFIC_TIME_ZONE } from "../lib/pacific-dates.js";

// Staff taps that start work on an Issue, so they time the first response.
const RESPONSE_TYPES = `('task_completed', 'escalation_action_taken',
  '311_ticket_filed', 'custom_action_taken', 'action_taken', 'issue_resolved')`;
// Only possible after a response, so they prove one happened but not when.
const LATER_TYPES = `('note_photo_update', 'resolution_proof',
  'presence_resolved', 'presence_still_present', 'additional_action',
  'additional_action_resolved', 'additional_action_still_present')`;
const CLOSED_TYPES = `('task_completed', 'issue_resolved', 'presence_resolved',
  'additional_action_resolved')`;
const RESPONDED_STATUSES = `('in_progress', 'completed', 'resolving', 'completing')`;

/**
 * @param {string} evaluatedAt ISO instant, already checked
 * @returns {string}
 */
export function snapshotMacrosSql(evaluatedAt) {
  return `
-- A date with no time is UTC midnight, as Date.parse reads it; infinity isn't a time.
CREATE OR REPLACE TEMP MACRO cast_time(v) AS
  TRY_CAST(CASE WHEN regexp_full_match(v, '\\d{4}-\\d{2}-\\d{2}')
    THEN v || 'T00:00:00Z' ELSE v END AS TIMESTAMPTZ);
CREATE OR REPLACE TEMP MACRO parse_time(v) AS
  CASE WHEN isfinite(cast_time(v)) THEN date_trunc('millisecond', cast_time(v)) END;
CREATE OR REPLACE TEMP MACRO iso_time(t) AS
  strftime(timezone('UTC', t), '%Y-%m-%dT%H:%M:%S.%gZ');
CREATE OR REPLACE TEMP MACRO pacific_day(t) AS
  CAST(timezone('${PACIFIC_TIME_ZONE}', t) AS DATE);
CREATE OR REPLACE TEMP MACRO snapshot_at() AS TIMESTAMPTZ '${new Date(Date.parse(evaluatedAt)).toISOString()}';
-- A record after the snapshot hadn't happened yet at that time.
CREATE OR REPLACE TEMP MACRO by_snapshot(t) AS CASE WHEN t <= snapshot_at() THEN t END;
`;
}

export const RULES_SQL = `
-- Rule 1: replaced, deleted, undated and future tasks never count. Read
-- status, not the assessment: a refresh keeps acted-on tasks under the old
-- assessment ID (guidance-store.js).
CREATE OR REPLACE TEMP TABLE task_states AS
SELECT *, parse_time(createdAt) AS createdTs,
  CASE WHEN status = 'deleted' THEN 'deleted'
    WHEN status = 'superseded' THEN 'superseded'
    WHEN parse_time(createdAt) IS NULL THEN 'undated'
    WHEN parse_time(createdAt) > snapshot_at() THEN 'afterSnapshot'
    ELSE 'live' END AS state
FROM in_tasks;

CREATE OR REPLACE TEMP TABLE condition_orders AS
SELECT siteId, assessmentId, conditionId, any_value(taskIds) AS taskIds
FROM in_conditions GROUP BY ALL;

-- Rule 2: one condition is one Issue, led by the task the app lists first,
-- then the earliest; its follow-up tasks join it.
CREATE OR REPLACE TEMP TABLE live_tasks AS
SELECT t.*, CASE WHEN coalesce(t.conditionId, '') = '' THEN t.taskId
  ELSE first_value(t.taskId) OVER (
    PARTITION BY t.siteId, t.assessmentId, t.conditionId
    ORDER BY coalesce(list_position(c.taskIds, t.taskId), len(c.taskIds) + 1, 0),
      t.createdTs, t.taskId) END AS primaryId
FROM task_states t
LEFT JOIN condition_orders c ON c.siteId = t.siteId
  AND c.assessmentId IS NOT DISTINCT FROM t.assessmentId
  AND c.conditionId = t.conditionId
WHERE t.state = 'live';

-- Rule 3: a linked duplicate joins its original's Issue unless staff
-- separated it; a link to a follow-up task means that task's Issue.
CREATE OR REPLACE TEMP TABLE task_links AS
SELECT l.siteId, l.taskId,
  any_value(coalesce(o.primaryId, l.originalTaskId, '')) AS nextId
FROM in_links l
LEFT JOIN live_tasks o ON o.siteId = l.siteId AND o.taskId = l.originalTaskId
WHERE NOT EXISTS (SELECT 1 FROM in_overrides x
  WHERE x.siteId = l.siteId AND x.taskId = l.taskId)
GROUP BY l.siteId, l.taskId;

-- Rule 3, continued: follow links past replaced sightings to the last
-- original (duplicates/group.js). A cycle, or a chain ending at a dropped
-- task, leaves the sighting as its own Issue.
CREATE OR REPLACE TEMP TABLE issue_roots AS
WITH RECURSIVE walk(siteId, startId, cur, seen, cycle) AS (
  SELECT DISTINCT p.siteId, p.primaryId, p.primaryId, []::VARCHAR[], false
  FROM live_tasks p
  SEMI JOIN task_links k ON k.siteId = p.siteId AND k.taskId = p.primaryId
  UNION ALL
  SELECT w.siteId, w.startId,
    CASE WHEN list_contains(w.seen, w.cur) THEN w.cur ELSE k.nextId END,
    list_append(w.seen, w.cur), list_contains(w.seen, w.cur)
  FROM walk w JOIN task_links k ON k.siteId = w.siteId AND k.taskId = w.cur
  WHERE NOT w.cycle),
ends AS (
  SELECT siteId, startId, bool_or(cycle) AS cycle,
    arg_max(cur, len(seen)) AS lastId
  FROM walk GROUP BY ALL)
SELECT e.siteId, e.startId,
  CASE WHEN NOT e.cycle AND x.taskId IS NOT NULL THEN e.lastId
    ELSE e.startId END AS rootId
FROM ends e
LEFT JOIN live_tasks x ON x.siteId = e.siteId AND x.taskId = e.lastId;

CREATE OR REPLACE TEMP TABLE issue_members AS
SELECT t.*, coalesce(r.rootId, t.primaryId) AS rootId
FROM live_tasks t
LEFT JOIN issue_roots r ON r.siteId = t.siteId AND r.startId = t.primaryId;

-- Rule 4: timeline events up to the snapshot; one with no readable time
-- still proves a response.
CREATE OR REPLACE TEMP TABLE issue_events AS
SELECT m.siteId, m.rootId, m.taskId, u.type,
  parse_time(u.occurredAt) AS occurredTs
FROM issue_members m
JOIN in_updates u ON u.siteId = m.siteId AND u.taskId = m.taskId
WHERE NOT coalesce(parse_time(u.occurredAt) > snapshot_at(), false);

-- Rule 5: the first response is the earliest staff tap, or the task's own
-- times for filings whose event isn't written yet and pre-event records.
CREATE OR REPLACE TEMP TABLE issue_timing AS
WITH events AS (
  SELECT siteId, rootId,
    min(occurredTs) FILTER (WHERE type IN ${RESPONSE_TYPES}) AS firstEventTs,
    bool_or(type IN ${RESPONSE_TYPES} OR type IN ${LATER_TYPES}) AS anyEvent,
    max(occurredTs) AS lastEventTs,
    -- Reopened means the Issue's own task was closed, not a follow-up.
    bool_or(taskId = rootId AND type IN ${CLOSED_TYPES}) AS rootClosed
  FROM issue_events GROUP BY ALL),
records AS (
  SELECT siteId, rootId,
    least(min(parse_time(inProgressAt)), min(parse_time(completedAt))
      FILTER (WHERE status IN ${RESPONDED_STATUSES})) AS firstRecordTs,
    coalesce(bool_or(status IN ${RESPONDED_STATUSES}), false) AS anyRespondedStatus,
    max(greatest(by_snapshot(parse_time(updatedAt)),
      by_snapshot(parse_time(inProgressAt)),
      by_snapshot(parse_time(completedAt)))) AS lastRecordTs,
    count(*) FILTER (WHERE taskId = primaryId) AS sightings,
    count(*) FILTER (WHERE taskId <> primaryId) AS followUpTasks
  FROM issue_members GROUP BY ALL)
SELECT r.*, e.firstEventTs, e.lastEventTs,
  coalesce(e.anyEvent, false) AS anyEvent,
  coalesce(e.rootClosed, false) AS rootClosed,
  least(e.firstEventTs, r.firstRecordTs) AS earliestTs
FROM records r LEFT JOIN events e USING (siteId, rootId);

CREATE OR REPLACE TEMP TABLE issue_facts AS
WITH timed AS (
  SELECT *,
    -- A first response after the snapshot hadn't happened yet.
    coalesce(earliestTs > snapshot_at(), false) AS notYet
  FROM issue_timing),
flows AS (
  SELECT siteId, checkId, any_value(flowType) AS flowType
  FROM in_checks GROUP BY ALL)
SELECT t.taskId AS issueId, t.siteId, t.checkId,
  -- The app treats any flow type but single-problem as perimeter.
  CASE WHEN f.siteId IS NULL THEN 'unknown'
    WHEN f.flowType = 'single-problem' THEN 'single-problem'
    ELSE 'perimeter' END AS source,
  t.createdAt, t.createdTs, pacific_day(t.createdTs) AS createdDay,
  -- Older rulebooks used other names for some categories; one name each
  -- keeps their counts together.
  CASE WHEN coalesce(t.category, '') <> ''
    THEN coalesce(n.reportCategory, t.category) END AS category,
  CASE WHEN t.severity = trunc(t.severity)
    THEN TRY_CAST(t.severity AS INTEGER) END AS severity,
  CASE WHEN t.severity IN (4, 5) THEN 'severe'
    WHEN t.severity = 3 THEN 'moderate'
    WHEN t.severity IN (1, 2) THEN 'minor'
    ELSE 'unknown' END AS severityBand,
  t.kind, t.type, t.status,
  -- Rule 6: the Issue's first task is the one staff saw, so its window
  -- applies. Older tasks get their rule's current window, as
  -- handlers/tasks.js does, else the plan's 72 hours.
  CASE WHEN isfinite(t.maxAcceptableResponseHours)
      AND t.maxAcceptableResponseHours >= 0 THEN t.maxAcceptableResponseHours
    WHEN isfinite(h.hours) AND h.hours >= 0 THEN h.hours
    ELSE 72 END AS hours,
  CASE WHEN m.notYet THEN NULL ELSE m.earliestTs END AS firstResponseTs,
  m.firstEventTs,
  -- Events are already cut at the snapshot, so they still prove a response.
  m.anyEvent OR (NOT m.notYet AND m.anyRespondedStatus) AS responded,
  -- Resolved only once the task completed, by the snapshot.
  CASE WHEN t.status = 'completed' THEN coalesce(t.resolvedAt, t.completedAt)
    END AS resolvedCandidate,
  coalesce(t.status IN ('open', 'in_progress'), false) AND m.rootClosed AS reopened,
  m.sightings, m.followUpTasks,
  greatest(t.createdTs, m.lastRecordTs, m.lastEventTs) AS latestActivityTs
FROM timed m
JOIN live_tasks t ON t.siteId = m.siteId AND t.taskId = m.rootId
LEFT JOIN flows f ON f.siteId = t.siteId AND f.checkId = t.checkId
LEFT JOIN category_names n ON n.category = t.category
LEFT JOIN rule_hours h ON h.ruleId = t.ruleId;

-- Rule 7: response state as of the snapshot. 0 hours turns the overdue
-- check off, as the app does for "Call 911" rules (domain/task-updates.js).
CREATE OR REPLACE TEMP TABLE p_issues AS
WITH deadlines AS (
  SELECT *, CASE WHEN hours > 0 THEN createdTs
    + to_milliseconds(CAST(trunc(hours * 3600000) AS BIGINT)) END AS deadlineTs
  FROM issue_facts)
SELECT issueId, siteId, checkId, source, createdAt, createdTs, createdDay,
  category, severity, severityBand, kind, type, status,
  iso_time(deadlineTs) AS deadlineAt,
  iso_time(firstResponseTs) AS firstResponseAt,
  CASE WHEN firstResponseTs IS NULL THEN NULL
    WHEN firstEventTs = firstResponseTs THEN 'timeline'
    ELSE 'task_record' END AS responseBasis,
  CASE WHEN hours = 0 THEN 'notTimed'
    WHEN firstResponseTs IS NOT NULL THEN
      CASE WHEN firstResponseTs <= deadlineTs THEN 'onTime' ELSE 'late' END
    -- A response with no time can't be judged on time or late.
    WHEN responded THEN 'unknown'
    WHEN snapshot_at() > deadlineTs THEN 'overdue'
    ELSE 'awaiting' END AS responseState,
  CASE WHEN by_snapshot(parse_time(resolvedCandidate)) IS NOT NULL
    THEN resolvedCandidate END AS resolvedAt,
  reopened, sightings, followUpTasks,
  iso_time(latestActivityTs) AS latestActivityAt
FROM deadlines;

-- Rule 8: a Check counts on the Pacific day it finished, or started if it
-- was unfinished at the snapshot. Older headers may lack completedAt, and
-- synthesis happens at completion.
CREATE OR REPLACE TEMP TABLE check_days AS
WITH times AS (
  SELECT siteId, flowType, status,
    coalesce(parse_time(completedAt), parse_time(synthesizedAt)) AS finishedTs,
    parse_time(startedAt) AS startedTs
  FROM in_checks),
judged AS (
  SELECT *, coalesce(status = 'completed', false)
    AND NOT coalesce(finishedTs > snapshot_at(), false) AS done
  FROM times)
SELECT siteId, flowType, done,
  -- With no finish time at all, the start day is the best day left.
  CASE WHEN done THEN coalesce(finishedTs, startedTs) ELSE startedTs END AS countedTs
FROM judged;

-- Checks count as activity only; nothing here knows how many were expected.
CREATE OR REPLACE TEMP TABLE p_site_days AS
WITH activity AS (
  SELECT siteId, pacific_day(countedTs) AS day,
    CASE WHEN NOT done THEN 'unfinished'
      WHEN flowType = 'single-problem' THEN 'single'
      ELSE 'perimeter' END AS checkKind,
    NULL AS severityBand, NULL AS responseState
  FROM check_days WHERE countedTs <= snapshot_at()
  UNION ALL
  SELECT siteId, createdDay, NULL, severityBand, responseState FROM p_issues)
SELECT siteId, day,
  count(*) FILTER (WHERE checkKind = 'perimeter') AS completedPerimeterChecks,
  count(*) FILTER (WHERE checkKind = 'single') AS singleIssueReports,
  count(*) FILTER (WHERE checkKind = 'unfinished') AS unfinishedChecks,
  count(responseState) AS issuesCreated,
  count(*) FILTER (WHERE severityBand = 'severe') AS severeIssues,
  count(*) FILTER (WHERE responseState = 'awaiting') AS awaiting,
  count(*) FILTER (WHERE responseState = 'overdue') AS overdue,
  count(*) FILTER (WHERE responseState = 'onTime') AS onTime,
  count(*) FILTER (WHERE responseState = 'late') AS late,
  count(*) FILTER (WHERE responseState = 'unknown') AS "unknown",
  count(*) FILTER (WHERE responseState = 'notTimed') AS notTimed
FROM activity GROUP BY siteId, day;

-- Counts of left-out records, so a drop in totals can be explained.
CREATE OR REPLACE TEMP TABLE p_data_quality AS
SELECT
  (SELECT count(*) FILTER (WHERE state = 'superseded') FROM task_states) AS superseded,
  (SELECT count(*) FILTER (WHERE state = 'deleted') FROM task_states) AS deleted,
  (SELECT count(*) FILTER (WHERE taskId <> primaryId) FROM issue_members) AS followUp,
  (SELECT count(*) FILTER (WHERE taskId = primaryId AND rootId <> taskId)
    FROM issue_members) AS duplicate,
  (SELECT count(*) FILTER (WHERE state = 'afterSnapshot') FROM task_states) AS afterSnapshot,
  (SELECT count(*) FILTER (WHERE state = 'undated') FROM task_states) AS undated,
  (SELECT count(*) FILTER (WHERE countedTs IS NULL) FROM check_days) AS undatedChecks;
`;

// How each projection table's rows are ordered in its file.
/** @type {Record<string, string>} */
export const TABLE_ORDER = {
  site_days: "siteId, day",
  issues: "siteId, createdTs, issueId",
};
