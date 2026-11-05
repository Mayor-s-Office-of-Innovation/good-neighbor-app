// Applied once per snapshot, so the UI, CSV and PDF count the same Issues.
// An Issue is a live condition's first task; follow-ups and linked duplicates
// are its evidence.

import { activeCatalog } from "../analysis/guidance/catalog-registry.js";
import { resolveCategory } from "../analysis/guidance/category-resolver.js";
import { pacificDateKey } from "../lib/pacific-dates.js";
import {
  responseDeadline,
  responseHours,
  responseState,
  severityBand,
} from "./indicators.js";

// Staff taps that start work on an Issue, so they time the first response.
const RESPONSE_TYPES = new Set([
  "task_completed",
  "escalation_action_taken",
  "311_ticket_filed",
  "custom_action_taken",
  "action_taken",
  "issue_resolved",
]);
// Only possible after a response, so they prove one happened but not when.
const LATER_TYPES = new Set([
  "note_photo_update",
  "resolution_proof",
  "presence_resolved",
  "presence_still_present",
  "additional_action",
  "additional_action_resolved",
  "additional_action_still_present",
]);
const CLOSED_TYPES = new Set([
  "task_completed",
  "issue_resolved",
  "presence_resolved",
  "additional_action_resolved",
]);
const RESPONDED_STATUSES = new Set([
  "in_progress",
  "completed",
  "resolving",
  "completing",
]);
const DEAD_STATUSES = new Set(["superseded", "deleted"]);
const REOPENED_STATUSES = new Set(["open", "in_progress"]);

/**
 * @typedef {{ siteId: string, taskId: string, status: string, createdAt: string,
 *   category?: string | null, severity?: number | null, kind?: string | null, type?: string | null,
 *   checkId?: string | null, assessmentId?: string | null, conditionId?: string | null,
 *   inProgressAt?: string | null, completedAt?: string | null, resolvedAt?: string | null,
 *   updatedAt?: string | null, ruleId?: string | null,
 *   maxAcceptableResponseHours?: number | null }} TaskRow
 */

/**
 * @typedef {object} IssueInputs
 * @property {TaskRow[]} tasks
 * @property {{ siteId: string, assessmentId: string, conditionId: string, taskIds: string[] }[]} conditions
 * @property {{ siteId: string, taskId: string, type: string, occurredAt: string }[]} updates
 * @property {{ siteId: string, taskId: string, originalTaskId: string }[]} links
 * @property {{ siteId: string, taskId: string }[]} overrides
 * @property {{ siteId: string, checkId: string, flowType?: string | null }[]} checks
 */

/**
 * @typedef {object} IssueFact
 * @property {string} issueId
 * @property {string} siteId
 * @property {string | null} checkId
 * @property {string} source perimeter, single-problem or unknown
 * @property {string} createdAt
 * @property {string} createdDay
 * @property {string | null} category
 * @property {number | null} severity
 * @property {string} severityBand
 * @property {string | null} kind
 * @property {string | null} type
 * @property {string} status
 * @property {string | null} deadlineAt
 * @property {string | null} firstResponseAt
 * @property {string | null} responseBasis timeline, task_record or null
 * @property {string} responseState
 * @property {string | null} resolvedAt
 * @property {boolean} reopened
 * @property {number} sightings
 * @property {number} followUpTasks
 * @property {string} latestActivityAt
 */

/**
 * @param {string} siteId
 * @param {string | null | undefined} id
 * @returns {string}
 */
const key = (siteId, id) => `${siteId}|${id}`;

// Older rulebooks used other names for some categories; one name each keeps their counts together.
/**
 * @param {string | null | undefined} category
 * @returns {string | null}
 */
export function reportCategory(category) {
  if (!category) return null;
  const found = resolveCategory(category, activeCatalog());
  return found.kind === "resolved" ? found.category : category;
}

/**
 * @param {(string | null | undefined)[]} values
 * @param {(a: number, b: number) => number} pick
 * @returns {string | null}
 */
function pickTime(values, pick) {
  const times = values
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter(Number.isFinite);
  return times.length
    ? new Date(times.reduce((a, b) => pick(a, b))).toISOString()
    : null;
}

/**
 * @param {TaskRow} task
 * @param {number} cutoff
 * @returns {string | null}
 */
function resolvedBy(task, cutoff) {
  const at =
    task.status === "completed"
      ? (task.resolvedAt ?? task.completedAt ?? null)
      : null;
  return at && Date.parse(at) <= cutoff ? at : null;
}

/**
 * @param {IssueInputs} inputs
 * @param {string} evaluatedAt
 * @returns {{ issues: IssueFact[], dropped: Record<string, number> }}
 */
export function buildIssueFacts(inputs, evaluatedAt) {
  const cutoff = Date.parse(evaluatedAt);
  /**
   * @template T
   * @param {Map<string, T[]>} map
   * @param {string} k
   * @param {T} value
   */
  const append = (map, k, value) => {
    const list = map.get(k);
    if (list) list.push(value);
    else map.set(k, [value]);
  };
  const dropped = {
    superseded: 0,
    deleted: 0,
    followUp: 0,
    duplicate: 0,
    afterSnapshot: 0,
    undated: 0,
  };
  const conditionOrder = new Map(
    inputs.conditions.map((c) => [
      key(c.siteId, `${c.assessmentId}#${c.conditionId}`),
      c.taskIds ?? [],
    ]),
  );
  const flowByCheck = new Map(
    inputs.checks.map((c) => [key(c.siteId, c.checkId), c.flowType]),
  );

  /** @type {Map<string, TaskRow>} */
  const live = new Map();
  for (const task of inputs.tasks) {
    // Read status, not the assessment: a refresh keeps acted-on tasks under the
    // old assessment ID (guidance-store.js).
    if (DEAD_STATUSES.has(task.status)) {
      dropped[task.status === "deleted" ? "deleted" : "superseded"] += 1;
      continue;
    }
    if (!Number.isFinite(Date.parse(task.createdAt))) {
      dropped.undated += 1;
      continue;
    }
    if (Date.parse(task.createdAt) > cutoff) {
      dropped.afterSnapshot += 1;
      continue;
    }
    live.set(key(task.siteId, task.taskId), task);
  }

  // One condition is one Issue, so its follow-up tasks join the first task.
  /** @type {Map<string, TaskRow[]>} */
  const byCondition = new Map();
  for (const task of live.values()) {
    if (!task.conditionId) continue;
    append(
      byCondition,
      key(task.siteId, `${task.assessmentId}#${task.conditionId}`),
      task,
    );
  }
  const created = (/** @type {TaskRow} */ t) => Date.parse(t.createdAt);
  /** @type {Map<string, string>} task key → primary task key */
  const primaryOf = new Map();
  for (const [k, tasks] of byCondition) {
    const order = conditionOrder.get(k) ?? [];
    const rank = (/** @type {TaskRow} */ t) => {
      const i = order.indexOf(t.taskId);
      return i === -1 ? order.length : i;
    };
    const [primary] = [...tasks].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        created(a) - created(b) ||
        a.taskId.localeCompare(b.taskId),
    );
    for (const t of tasks)
      primaryOf.set(
        key(t.siteId, t.taskId),
        key(primary.siteId, primary.taskId),
      );
  }
  const primary = (/** @type {string} */ k) => primaryOf.get(k) ?? k;

  // Duplicates follow links to the last original (duplicates/group.js).
  const separated = new Set(
    inputs.overrides.map((o) => key(o.siteId, o.taskId)),
  );
  const linkOf = new Map(
    inputs.links
      .filter((l) => !separated.has(key(l.siteId, l.taskId)))
      .map((l) => [key(l.siteId, l.taskId), key(l.siteId, l.originalTaskId)]),
  );
  /**
   * @param {string} k
   * @returns {string}
   */
  const rootOf = (k) => {
    const seen = new Set();
    let at = k;
    while (linkOf.has(at)) {
      if (seen.has(at)) return k;
      seen.add(at);
      const next = /** @type {string} */ (linkOf.get(at));
      // A link to a follow-up task means that task's Issue.
      at = live.has(next) ? primary(next) : next;
    }
    return live.has(at) ? at : k;
  };

  /** @type {Map<string, TaskRow[]>} root key → member tasks */
  const groups = new Map();
  for (const [k, task] of live) {
    const root = rootOf(primary(k));
    if (root !== k) dropped[primary(k) === k ? "duplicate" : "followUp"] += 1;
    append(groups, root, task);
  }

  /** @type {Map<string, { type: string, occurredAt: string }[]>} */
  const updatesByTask = new Map();
  for (const u of inputs.updates) {
    if (Date.parse(u.occurredAt) > cutoff) continue;
    append(updatesByTask, key(u.siteId, u.taskId), u);
  }

  /** @type {IssueFact[]} */
  const issues = [];
  for (const [rootKey, members] of groups) {
    const root = /** @type {TaskRow} */ (live.get(rootKey));
    const events = members.flatMap(
      (m) => updatesByTask.get(key(m.siteId, m.taskId)) ?? [],
    );
    const timed = events
      .filter((e) => RESPONSE_TYPES.has(e.type))
      .map((e) => e.occurredAt);
    // Task times cover filings whose event isn't written yet, and pre-event
    // records.
    const recorded = members.flatMap((m) => [
      m.inProgressAt,
      RESPONDED_STATUSES.has(m.status) ? m.completedAt : null,
    ]);
    const earliest = pickTime([...timed, ...recorded], Math.min);
    // A first response after the snapshot hadn't happened yet at that time.
    const notYet = earliest !== null && Date.parse(earliest) > cutoff;
    const firstResponseAt = notYet ? null : earliest;
    // Events are already cut at the snapshot, so they still prove a response.
    const responded =
      events.some(
        (e) => RESPONSE_TYPES.has(e.type) || LATER_TYPES.has(e.type),
      ) ||
      (!notYet && members.some((m) => RESPONDED_STATUSES.has(m.status)));
    const createdAt = root.createdAt;
    // The Issue's first task is the one staff saw, so its rule sets the window.
    const hours = responseHours(root);
    const issue = {
      createdAt,
      firstResponseAt,
      responded,
      responseHours: hours,
    };
    const rootClosed = (updatesByTask.get(rootKey) ?? []).some((e) =>
      CLOSED_TYPES.has(e.type),
    );
    issues.push({
      issueId: root.taskId,
      siteId: root.siteId,
      checkId: root.checkId ?? null,
      // The app treats any flow type but single-problem as perimeter.
      source: !flowByCheck.has(key(root.siteId, root.checkId))
        ? "unknown"
        : flowByCheck.get(key(root.siteId, root.checkId)) === "single-problem"
          ? "single-problem"
          : "perimeter",
      createdAt,
      createdDay: pacificDateKey(createdAt),
      category: reportCategory(root.category),
      severity: Number.isInteger(root.severity) ? Number(root.severity) : null,
      severityBand: severityBand(root.severity),
      kind: root.kind ?? null,
      type: root.type ?? null,
      status: root.status,
      deadlineAt: responseDeadline(createdAt, hours),
      firstResponseAt,
      responseBasis: firstResponseAt
        ? pickTime(timed, Math.min) === firstResponseAt
          ? "timeline"
          : "task_record"
        : null,
      responseState: responseState(issue, evaluatedAt),
      resolvedAt: resolvedBy(root, cutoff),
      reopened: REOPENED_STATUSES.has(root.status) && rootClosed,
      sightings: members.filter(
        (m) => primary(key(m.siteId, m.taskId)) === key(m.siteId, m.taskId),
      ).length,
      followUpTasks: members.filter(
        (m) => primary(key(m.siteId, m.taskId)) !== key(m.siteId, m.taskId),
      ).length,
      latestActivityAt: /** @type {string} */ (
        pickTime(
          [
            createdAt,
            ...members.flatMap((m) => [
              m.updatedAt,
              m.inProgressAt,
              m.completedAt,
            ]),
            ...events.map((e) => e.occurredAt),
          ].filter((v) => v && Date.parse(v) <= cutoff),
          Math.max,
        ) ?? createdAt
      ),
    });
  }
  issues.sort(
    (a, b) =>
      a.siteId.localeCompare(b.siteId) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.issueId.localeCompare(b.issueId),
  );
  return { issues, dropped };
}
