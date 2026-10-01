/*
  home-tasks — pure read-model helpers for the home hub (today-view).

  Task status buckets, "new" and "archived" windows, check grouping, session ↔
  backend task matching, and the small formatters the home screen prints.
  Nothing here touches the DOM, storage, or the network; today-view.js owns
  the element and calls into this module.
*/

export const HOME_TABS = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "history", label: "History" },
];
const NEW_TASK_WINDOW_MS = 3 * 60 * 60 * 1000;
const ARCHIVE_AFTER_MS = 72 * 60 * 60 * 1000;
const SITE_RADIUS_METERS = 201.168; // One eighth of a mile.

/**
 * @param {string | number | Date} expectedAt
 * @param {string | number | Date} [now]
 */
export function formatOverdueElapsed(expectedAt, now = Date.now()) {
  const elapsedHours = Math.max(
    1,
    Math.floor(
      (new Date(now).getTime() - new Date(expectedAt).getTime()) / 3_600_000,
    ),
  );
  if (elapsedHours < 24) {
    return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"}`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"}`;
}

export function submitted311Ticket(task) {
  for (const result of task?.appActionResults || []) {
    if (result?.code !== "create_311_ticket") continue;
    const ticket = result?.payload?.tickets?.find((item) => item?.srNum);
    if (ticket) return ticket;
  }
  return null;
}

/**
 * @param {{latitude: number, longitude: number} | null | undefined} position
 * @param {{latitude: number, longitude: number} | null | undefined} site
 * @returns {boolean}
 */
export function isOutsideSiteRadius(position, site) {
  if (!position || !site) return false;
  const { latitude: lat1, longitude: lon1 } = position;
  const { latitude: lat2, longitude: lon2 } = site;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return false;
  if (
    Math.abs(lat1) > 90 ||
    Math.abs(lat2) > 90 ||
    Math.abs(lon1) > 180 ||
    Math.abs(lon2) > 180
  )
    return false;
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLon = (lon2 - lon1) * radians;
  const arc =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1 * radians) *
      Math.cos(lat2 * radians) *
      Math.sin(deltaLon / 2) ** 2;
  return (
    6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(arc))) > SITE_RADIUS_METERS
  );
}

/**
 * Decide whether a local pending/review session has been superseded by backend history.
 * @param {{ id: string, status?: string, submittedAt?: string, items?: Array<{analysis?: {status?: string, tasks?: Array<{taskId?: string, conditionId?: string, assessmentId?: string}>, conditions?: Array<{conditionId?: string}>}}> } | null} session
 * @param {Array<{ id: string, status?: string, submittedAt?: string }>} submitted
 * @param {Array<{taskId?: string, conditionId?: string, assessmentId?: string}>} [tasks]
 * @returns {boolean}
 */
export function isStalePendingSession(session, submitted, tasks = []) {
  if (!session) return false;
  if (session.status === "capture-complete") {
    // The backend check can be submitted before per-artifact guidance has
    // finished. Keep the local results alive until every captured item has
    // settled; otherwise its last analysis update cannot refresh home.
    const items = Array.isArray(session.items) ? session.items : [];
    if (items.some((item) => item.analysis?.status !== "analyzed")) {
      return false;
    }
    if (
      items.some(
        (item) =>
          hasProblemResults(item) &&
          !sessionProblemItemHasBackendCards(item, tasks),
      )
    ) {
      return false;
    }
    return submitted.some((check) => check.id === session.id);
  }
  if (submitted.some((check) => check.id === session.id)) return false;
  if (!session.submittedAt || !submitted.length) return false;
  return submitted.some(
    (check) =>
      check.submittedAt &&
      check.submittedAt.localeCompare(session.submittedAt) >= 0,
  );
}

/**
 * @param {string} status
 * @returns {"todo" | "in_progress" | "history"}
 */
export function homeTabForStatus(status) {
  if (status === "needs_action") return "todo";
  if (status === "in_progress") return "in_progress";
  return "history";
}

export function normalizedHomeTab(value) {
  if (value === "needs_action") return "todo";
  if (value === "resolved" || value === "archived") return "history";
  return HOME_TABS.some((tab) => tab.id === value) ? value : "todo";
}

export function homeTaskStatus(task, override, now = new Date()) {
  const status = String(task.status || "open");
  if (
    status === "completing" ||
    status === "resolving" ||
    status === "in_progress"
  ) {
    return "in_progress";
  }
  if (status === "completed" || status === "cannot_do") {
    if (
      status === "completed" &&
      task.completionMethod === "311_filed" &&
      !hasCompleted311Ticket(task)
    ) {
      return "in_progress";
    }
    const resolvedAt =
      task.completedAt ||
      task.completed_at ||
      task.resolvedAt ||
      task.resolved_at ||
      task.updatedAt ||
      task.updated_at ||
      taskCreatedAt(task);
    return ageMs(resolvedAt, now) >= ARCHIVE_AFTER_MS ? "archived" : "resolved";
  }
  if (override?.status === "in_progress") return "in_progress";
  if (override?.status === "resolved") {
    return ageMs(override.updatedAt, now) >= ARCHIVE_AFTER_MS
      ? "archived"
      : "resolved";
  }
  return "needs_action";
}

function hasCompleted311Ticket(task) {
  const terminalStatuses = new Set(["closed", "completed", "resolved"]);
  return (task.appActionResults || []).some(
    (result) =>
      result?.code === "create_311_ticket" &&
      terminalStatuses.has(String(result.status || "").toLowerCase()),
  );
}

export function isNewHomeTask(task, override, now = new Date()) {
  return (
    homeTaskStatus(task, override, now) === "needs_action" &&
    ageMs(taskCreatedAt(task), now) < NEW_TASK_WINDOW_MS
  );
}

export function taskCreatedAt(task) {
  if (task.createdAt) return task.createdAt;
  if (task.created_at) return task.created_at;
  if (task.updatedAt) return task.updatedAt;
  if (task.updated_at) return task.updated_at;
  const gsiDate = /^([^#]+)#/.exec(String(task.gsi2sk || ""));
  return gsiDate?.[1] || "";
}

export function displayTaskId(task) {
  return String(
    task.shortId ||
      task.displayId ||
      task.display_id ||
      task.assessmentId ||
      task.taskId ||
      "",
  );
}

export function issueCountLabel(count) {
  if (!count) return "";
  return `${count} ${count === 1 ? "issue" : "issues"} found`;
}

/**
 * @param {{ id?: string, submittedAt?: string | null, issueCount?: number } | null | undefined} last
 * @param {Array<{ task: { checkId?: string }, homeStatus: string }>} entries
 * @param {Date} [now]
 * @returns {string}
 */
export function lastLogSummary(last, entries, now = new Date()) {
  if (!last?.submittedAt) return "";
  const date = new Date(last.submittedAt);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day =
    date.toDateString() === now.toDateString()
      ? "today"
      : date.toDateString() === yesterday.toDateString()
        ? "yesterday"
        : new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const count = Number(last.issueCount) || 0;
  const needsAction = entries.some(
    (entry) =>
      entry.task.checkId === last.id && entry.homeStatus === "needs_action",
  );
  const outcome =
    count === 0
      ? "No issues found"
      : last.id && !needsAction
        ? "All issues handled"
        : issueCountLabel(count);
  return `Last log: ${day} at ${time} · ${outcome}`;
}

function ageMs(iso, now) {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, now.getTime() - timestamp);
}

export function uniqueTasks(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (!task?.taskId || byId.has(task.taskId)) continue;
    byId.set(task.taskId, task);
  }
  return [...byId.values()];
}

export function taskArtifactIdSet(tasks) {
  const artifactIds = new Set();
  for (const task of tasks || []) {
    for (const artifactId of taskArtifactIds(task)) {
      if (artifactId) artifactIds.add(artifactId);
    }
  }
  return artifactIds;
}

export function taskArtifactIds(task) {
  const explicitIds = Array.isArray(task?.sourceArtifactIds)
    ? task.sourceArtifactIds
    : [];
  const assessmentArtifactId = artifactIdFromAssessmentId(task?.assessmentId);
  return [...explicitIds, assessmentArtifactId].filter(Boolean);
}

export function hasProblemResults(item) {
  return Boolean(
    (item.analysis?.tasks || []).length ||
      (item.analysis?.conditions || []).length,
  );
}

export function sessionProblemItemHasBackendCards(item, tasks) {
  const backendTasks = Array.isArray(tasks) ? tasks : [];
  const localTasks = item?.analysis?.tasks || [];
  if (localTasks.length) {
    return localTasks.every((localTask) =>
      backendTasks.some((backendTask) =>
        sameProblemCard(localTask, backendTask),
      ),
    );
  }
  const localConditions = item?.analysis?.conditions || [];
  if (localConditions.length) {
    return localConditions.every((condition) =>
      backendTasks.some(
        (backendTask) =>
          condition.conditionId &&
          condition.conditionId === backendTask.conditionId,
      ),
    );
  }
  return false;
}

function sameProblemCard(localTask, backendTask) {
  return Boolean(
    (localTask.taskId && localTask.taskId === backendTask.taskId) ||
      (localTask.conditionId &&
        localTask.conditionId === backendTask.conditionId) ||
      (localTask.assessmentId &&
        localTask.assessmentId === backendTask.assessmentId),
  );
}

function artifactIdFromAssessmentId(assessmentId) {
  const value = String(assessmentId || "");
  const uuidPair =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      value,
    );
  return uuidPair?.[1] || "";
}

export function newestTaskEntriesFirst(entries) {
  return [...entries].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

export function taskCheckGroupId(task) {
  return task?.checkId || "unknown";
}

/**
 * @param {Array<{task: {checkId?: string}, createdAt?: string}>} entries
 * @param {Array<{id: string, submittedAt?: string, startedAt?: string, issueCount?: number}>} checks
 * @param {{id?: string, startedAt?: string, submittedAt?: string} | null} pendingSession
 * @param {Date} [now]
 * @returns {{id: string, time: string}}
 */
export function newestBlueCheckGroup(
  entries,
  checks,
  pendingSession,
  now = new Date(),
) {
  const checkTimes = new Map(
    (checks || []).map((check) => [
      check.id,
      check.submittedAt || check.startedAt || "",
    ]),
  );
  const candidates = new Map();
  for (const entry of entries || []) {
    const id = taskCheckGroupId(entry.task);
    const timestamp = checkTimes.get(id) || entry.createdAt || "";
    const previous = candidates.get(id) || "";
    if (String(timestamp).localeCompare(String(previous)) > 0) {
      candidates.set(id, timestamp);
    }
  }
  for (const check of checks || []) {
    if (Number(check.issueCount) !== 0 || !check.id) continue;
    candidates.set(
      check.id,
      check.submittedAt || check.startedAt || candidates.get(check.id) || "",
    );
  }
  if (pendingSession?.id) {
    candidates.set(
      pendingSession.id,
      pendingSession.startedAt || pendingSession.submittedAt || "",
    );
  }
  const newest = [...candidates.entries()].sort((a, b) =>
    String(b[1]).localeCompare(String(a[1])),
  )[0];
  if (!newest) return { id: "", time: "" };
  const date = new Date(newest[1]);
  if (
    Number.isNaN(date.getTime()) ||
    date.toDateString() !== now.toDateString()
  ) {
    return { id: "", time: "" };
  }
  return { id: newest[0], time: newest[1] };
}

export function visibleTaskEntriesForHydration(entries, homeFilter) {
  return entries.filter(
    (entry) => homeTabForStatus(entry.homeStatus) === homeFilter,
  );
}

export function timeOf(iso) {
  return new Date(iso)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, "")
    .toUpperCase();
}

// "TODAY" / "YESTERDAY" for the last 2 days, else the uppercase weekday.
export function relativeDay(iso) {
  const d = new Date(iso);
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ago = Math.round((todayStart.getTime() - dStart.getTime()) / 86400000);
  if (ago <= 0) return "TODAY";
  if (ago === 1) return "YESTERDAY";
  return d.toLocaleDateString([], { weekday: "long" }).toUpperCase();
}

export function splitSiteIdentity(name) {
  for (const delimiter of [" · ", " — ", " – ", " - ", ": "]) {
    if (!name.includes(delimiter)) continue;
    const [org, ...rest] = name.split(delimiter);
    const site = rest.join(delimiter).trim();
    if (org.trim() && site) {
      return { org: org.trim(), site };
    }
  }
  return null;
}
