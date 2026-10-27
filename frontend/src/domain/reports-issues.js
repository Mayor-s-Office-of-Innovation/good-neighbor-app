/*
  reports-issues — the combined Issues view's read model. Every issue is a
  task; what was done about it is read off the task record itself, so the
  "Issues" and "Actions" designs collapse into one list where each row
  carries its response. Pure functions over the tasks report (AP27).

  Response kinds, derived from stored fields (never from display labels):
    onSite        kind "action" resolved by the site team
    sr311         a 311 request was filed (completionMethod or agency)
    emergencyCall a non-actionable escalation whose rule said "Call 911"
    call          any other non-actionable escalation acted on (a phone call)
    cannotDo      marked "can't do" with a recorded reason
    open          nothing recorded yet
  Superseded tasks (replaced after an amendment) are not issues.
*/
import { submitted311Ticket } from "./home-tasks.js";
import { t } from "../i18n/i18n.js";
import { rulebookText, rulebookKey } from "../i18n/rulebook.js";
import {
  formatDateTime,
  formatMonthDay,
  pacificDateKey,
  pacificDaysAgo,
} from "../i18n/dates.js";
import { addDays, dayInstant, weekdayIndex } from "./reports-periods.js";

/** @typedef {"onSite" | "sr311" | "emergencyCall" | "call" | "cannotDo" | "open"} ResponseKind */

export const RESPONSE_KINDS = /** @type {ResponseKind[]} */ ([
  "onSite",
  "sr311",
  "emergencyCall",
  "call",
  "cannotDo",
  "open",
]);

const ACTED = ["in_progress", "completing", "resolving", "completed"];

/** @param {any} task */
function filed311(task) {
  return (
    task.completionMethod === "311_filed" ||
    task.agency === "311" ||
    task.inProgressActionKind === "311_filed"
  );
}

/** @param {any} task */
function saysCall911(task) {
  return (Array.isArray(task.buttons) ? task.buttons : []).some((label) =>
    /\b911\b/.test(String(label)),
  );
}

/**
 * What happened to one issue.
 * @param {any} task
 * @returns {{ kind: ResponseKind, label: string }}
 */
export function responseFor(task) {
  const status = String(task.status || "open");
  if (status === "cannot_do") {
    const reason = rulebookText(task.cannotDo?.reason || "");
    return {
      kind: "cannotDo",
      label: reason
        ? t("reports.issues.response.cannotDoReason", { reason })
        : t("reports.issues.response.cannotDo"),
    };
  }
  if (!ACTED.includes(status)) {
    return { kind: "open", label: t("reports.issues.response.open") };
  }
  if (filed311(task)) {
    return { kind: "sr311", label: t("reports.issues.response.sr311") };
  }
  if (task.kind === "non_actionable_escalation") {
    return saysCall911(task)
      ? {
          kind: "emergencyCall",
          label: t("reports.issues.response.emergencyCall"),
        }
      : { kind: "call", label: t("reports.issues.response.call") };
  }
  const detail =
    rulebookText(task.latestUpdateLabel || "") ||
    rulebookText(Array.isArray(task.buttons) ? task.buttons[0] : "");
  return {
    kind: "onSite",
    label: detail || t("reports.issues.response.onSite"),
  };
}

/** @param {any} task */
export function isIssue(task) {
  return Boolean(task?.taskId) && task.status !== "superseded";
}

/** @param {any} task */
export function issueTitle(task) {
  return (
    rulebookText(task.category || "") ||
    task.userFriendlyLabel ||
    t("card.title.fallback")
  );
}

/**
 * The key issues are grouped by: the raw rulebook category, so it survives
 * a language switch and can live in a report URL. Mirrors the backend's
 * `domain/issue-type.js`, which counts the previous period with it.
 * @param {any} task
 */
export function issueTypeKey(task) {
  return (
    String(task?.category || "").trim() ||
    String(task?.userFriendlyLabel || "").trim() ||
    "other"
  );
}

/** Known rulebook categories remain valid when a selected period is empty.
 * Legacy label-based keys are accepted when backed by returned records.
 * @param {string} key
 * @param {any[]} [tasks]
 */
export function isKnownIssueType(key, tasks = []) {
  return (
    key === "other" ||
    Boolean(
      rulebookKey(key, "rulebook.category.")?.startsWith("rulebook.category."),
    ) ||
    tasks.some((task) => isIssue(task) && issueTypeKey(task) === key)
  );
}

/**
 * Issues of one type, newest first.
 * @param {any[]} tasks
 * @param {string} key from issueTypeKey
 */
export function issuesOfType(tasks, key) {
  return tasks
    .filter((task) => isIssue(task) && issueTypeKey(task) === key)
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    );
}

/**
 * Display title for a type key: the title of any issue of that type, else
 * the key itself through the rulebook.
 * @param {any[]} tasks
 * @param {string} key
 */
export function issueTypeTitle(tasks, key) {
  const sample = tasks.find((task) => issueTypeKey(task) === key);
  return sample ? issueTitle(sample) : rulebookText(key) || key;
}

/**
 * "Last reported …": relative inside the last week, a date beyond it.
 * @param {string} iso
 * @param {Date} [now]
 */
export function lastReportedLabel(iso, now = new Date()) {
  const daysAgo = pacificDaysAgo(iso, now);
  if (daysAgo === 0) return t("reports.issues.lastReported.today");
  if (daysAgo === 1) return t("reports.issues.lastReported.yesterday");
  if (daysAgo !== null && daysAgo > 1 && daysAgo < 7)
    return t("reports.issues.lastReported.daysAgo", { count: daysAgo });
  return t("reports.issues.lastReported.date", { date: formatMonthDay(iso) });
}

/**
 * @typedef {object} IssueSummary
 * @property {number} total
 * @property {number} responded issues with any response but "open"
 * @property {Array<{ key: string, category: string, count: number, lastReportedAt: string }>} byCategory most frequent first
 * @property {Record<ResponseKind, number>} responses
 */

/**
 * @param {any[]} tasks
 * @returns {IssueSummary}
 */
export function summarizeIssues(tasks) {
  const issues = tasks.filter(isIssue);
  /** @type {Map<string, { key: string, category: string, count: number, lastReportedAt: string }>} */
  const categories = new Map();
  const responses = /** @type {Record<ResponseKind, number>} */ (
    Object.fromEntries(RESPONSE_KINDS.map((kind) => [kind, 0]))
  );
  let responded = 0;
  for (const task of issues) {
    const key = issueTypeKey(task);
    const entry = categories.get(key) ?? {
      key,
      category: issueTitle(task),
      count: 0,
      lastReportedAt: "",
    };
    entry.count += 1;
    const at = String(task.createdAt || "");
    if (at > entry.lastReportedAt) entry.lastReportedAt = at;
    categories.set(key, entry);
    const { kind } = responseFor(task);
    responses[kind] += 1;
    if (kind !== "open") responded += 1;
  }
  return {
    total: issues.length,
    responded,
    byCategory: [...categories.values()].sort(
      (a, b) => b.count - a.count || a.category.localeCompare(b.category),
    ),
    responses,
  };
}

/**
 * Issues found per day, with how many of them have a response.
 * @param {any[]} tasks
 * @param {string[]} dayKeys the period's days, ascending
 * @returns {Array<{ date: string, found: number, responded: number }>}
 */
export function issuesByDay(tasks, dayKeys, period = null) {
  const byDay = new Map(
    dayKeys.map((date) => [date, { date, found: 0, responded: 0 }]),
  );
  for (const task of tasks.filter(isIssue)) {
    const bucket = byDay.get(pacificDateKey(task.createdAt || ""));
    if (!bucket) continue;
    bucket.found += 1;
    if (
      period
        ? resolvedInPeriod(task, period)
        : responseFor(task).kind !== "open"
    )
      bucket.responded += 1;
  }
  return [...byDay.values()];
}

/**
 * Fold a period's daily issue counts into Sunday-start weeks, the same
 * buckets the checks quarter chart uses — a quarter's ~92 day bars would
 * collapse to hairlines, while ~13 weekly bars stay readable. The label
 * rides on the week that contains the month's 1st, same as weekBuckets.
 * @param {Array<{ date: string, found: number, responded: number }>} days
 *   as returned by issuesByDay, ascending, no gaps
 * @returns {Array<{ start: string, found: number, responded: number, monthLabel?: string }>}
 */
export function issuesByWeek(days) {
  const weeks = new Map();
  for (const day of days) {
    const start = addDays(day.date, -weekdayIndex(day.date));
    let week = weeks.get(start);
    if (!week) {
      week = { start, found: 0, responded: 0 };
      weeks.set(start, week);
    }
    week.found += day.found;
    week.responded += day.responded;
    if (day.date.endsWith("-01")) {
      week.monthLabel = formatDateTime(dayInstant(day.date), {
        month: "short",
      });
    }
  }
  return [...weeks.values()];
}

/**
 * The list rows, newest first.
 * @param {any[]} tasks
 */
export function issueRows(tasks) {
  return tasks
    .filter(isIssue)
    .slice()
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )
    .map((task) => ({
      taskId: String(task.taskId),
      shortId: String(task.shortId || ""),
      title: issueTitle(task),
      createdAt: String(task.createdAt || ""),
      status: String(task.status || "open"),
      response: responseFor(task),
    }));
}

/**
 * The list as CSV, one row per issue.
 * @param {any[]} tasks
 * @returns {string}
 */
export function issuesToCsv(tasks) {
  const header = ["found", "shortId", "type", "status", "response"];
  const rows = issueRows(tasks).map((row) => [
    row.createdAt,
    row.shortId,
    row.title,
    row.status,
    row.response.label,
  ]);
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (
    [header, ...rows].map((row) => row.map(cell).join(",")).join("\n") + "\n"
  );
}

/**
 * User-completed issues both found and completed within the selected Pacific period.
 * @param {any} task
 * @param {import("./reports-periods.js").Period} period
 */
export function resolvedInPeriod(task, period) {
  const found = pacificDateKey(task.createdAt || "");
  const completed = pacificDateKey(task.completedAt || task.resolvedAt || "");
  return (
    isIssue(task) &&
    task.status === "completed" &&
    found >= period.start &&
    found < period.endExclusive &&
    completed >= period.start &&
    completed < period.endExclusive
  );
}

/**
 * Percentage change; a zero denominator never produces an invented percentage.
 * @param {number} current @param {number} previous @param {string} kind
 */
export function issueTrend(current, previous, kind) {
  const label = t(`reports.period.previous.${kind}`);
  if (!previous) return t("reports.issues.trend.none", { previous: label });
  const percent = Math.round((Math.abs(current - previous) / previous) * 100);
  return t(
    current === previous
      ? "reports.delta.sameCount"
      : current > previous
        ? "reports.issues.trend.more"
        : "reports.issues.trend.less",
    { percent, previous: label },
  );
}

/** @param {any[]} tasks @param {import("./reports-periods.js").Period} period */
export function resolutionSummary(tasks, period) {
  const resolved = tasks.filter((task) => resolvedInPeriod(task, period));
  const times = resolved
    .map(
      (task) =>
        Date.parse(task.completedAt || task.resolvedAt) -
        Date.parse(task.createdAt),
    )
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length
    ? (times[middle] + times[Math.floor((times.length - 1) / 2)]) / 2
    : null;
  return {
    resolved: resolved.length,
    unresolved: tasks.length - resolved.length,
    median,
  };
}

/** @param {number | null} ms */
export function resolutionTime(ms) {
  if (ms === null) return t("reports.issues.median.none");
  const unit = ms < 3600000 ? "minutes" : ms < 86400000 ? "hours" : "days";
  const count = Math.max(
    1,
    Math.round(
      ms / (unit === "minutes" ? 60000 : unit === "hours" ? 3600000 : 86400000),
    ),
  );
  return t(`reports.issues.duration.${unit}`, { count });
}

/**
 * Historical attention uses dated actions. A non-open snapshot updated before
 * the cutoff also proves a status change; notes/photos alone never do.
 * @param {any} task @param {any} report
 */
export function attentionFlags(task, report) {
  const cutoff = Date.parse(report.asOf || new Date().toISOString());
  const before = (value) =>
    Number.isFinite(Date.parse(value)) && Date.parse(value) <= cutoff;
  const unresolved = !resolvedInPeriod(task, report.period);
  const action =
    (task.status && task.status !== "open" && before(task.updatedAt)) ||
    [
      task.inProgressAt,
      task.completedAt,
      task.resolvedAt,
      task.cannotDo?.at,
      task.cannotDo?.recordedAt,
      ...(task.appActionResults || []).map((result) => result.recordedAt),
    ].some(before) ||
    (report.updates || []).some(
      (update) =>
        update.taskId === task.taskId &&
        before(update.occurredAt) &&
        !["note", "note_photo_update", "photo", "task_created"].includes(
          update.type,
        ),
    );
  const ticket = submitted311Ticket(task);
  const request = task.report311;
  const submitted =
    request?.submittedAt || ticket?.submittedAt || task.inProgressAt;
  const closed = request?.events?.some(
    (event) =>
      before(event.occurredAt) &&
      (event.kind === "resolved" ||
        (event.kind === "statusChanged" && event.value === "Closed")),
  );
  const historical = report.period.endExclusive <= report.today;
  const waiting = Boolean(
    ticket &&
      request &&
      before(submitted) &&
      !closed &&
      (request.status !== "Closed" ||
        (historical &&
          request.events?.some(
            (event) =>
              event.kind === "resolved" &&
              Date.parse(event.occurredAt) > cutoff,
          ))),
  );
  return {
    unresolved,
    resolved: !unresolved,
    aged: unresolved && cutoff - Date.parse(task.createdAt) > 3 * 86400000,
    awaiting: waiting,
    noAction: unresolved && !action,
  };
}

/** @param {any[]} tasks @param {any} report @param {string} filter */
export function filterReportIssues(tasks, report, filter) {
  return filter
    ? tasks.filter((task) => attentionFlags(task, report)[filter])
    : tasks;
}
