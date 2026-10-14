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
import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { formatDateTime, pacificDateKey } from "../i18n/dates.js";
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
 * @typedef {object} IssueSummary
 * @property {number} total
 * @property {number} responded issues with any response but "open"
 * @property {Array<{ category: string, count: number, lastReportedAt: string }>} byCategory most frequent first
 * @property {Record<ResponseKind, number>} responses
 */

/**
 * @param {any[]} tasks
 * @returns {IssueSummary}
 */
export function summarizeIssues(tasks) {
  const issues = tasks.filter(isIssue);
  /** @type {Map<string, { category: string, count: number, lastReportedAt: string }>} */
  const categories = new Map();
  const responses = /** @type {Record<ResponseKind, number>} */ (
    Object.fromEntries(RESPONSE_KINDS.map((kind) => [kind, 0]))
  );
  let responded = 0;
  for (const task of issues) {
    const category = issueTitle(task);
    const entry = categories.get(category) ?? {
      category,
      count: 0,
      lastReportedAt: "",
    };
    entry.count += 1;
    const at = String(task.createdAt || "");
    if (at > entry.lastReportedAt) entry.lastReportedAt = at;
    categories.set(category, entry);
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
export function issuesByDay(tasks, dayKeys) {
  const byDay = new Map(
    dayKeys.map((date) => [date, { date, found: 0, responded: 0 }]),
  );
  for (const task of tasks.filter(isIssue)) {
    const bucket = byDay.get(pacificDateKey(task.createdAt || ""));
    if (!bucket) continue;
    bucket.found += 1;
    if (responseFor(task).kind !== "open") bucket.responded += 1;
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
