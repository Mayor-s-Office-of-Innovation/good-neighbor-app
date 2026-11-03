import { duplicateTaskVersion } from "./duplicate-invalidation.js";
import { listTasks } from "./api.js";
import { normalizedHomeTab } from "../domain/home-tasks.js";

// UI tabs overlap backend statuses: completed 311 tasks can still be in
// progress, and expired open/in-progress tasks belong to History.
/** @param {any} view
 * @param {{maxAge?: number, allStatuses?: boolean}} [options]
 */
export async function refreshActiveTab(
  view,
  { maxAge = 5 * 60 * 1000, allStatuses = false } = {},
) {
  if (
    !view.isConnected ||
    globalThis.navigator?.onLine === false ||
    document.visibilityState === "hidden" ||
    !view._homeModel ||
    view._homeRefresh ||
    view._remainingRefresh
  )
    return false;
  view._tabListStatus = () =>
    neededStatuses(view._homeFilter).every((status) =>
      view._taskListFreshness.has(status),
    )
      ? "loaded"
      : view._remainingStatus;
  const statuses = neededStatuses(allStatuses ? "history" : view._homeFilter);
  const stale = statuses.filter(
    (status) =>
      Date.now() - (view._taskListFreshness.get(status) || 0) >= maxAge,
  );
  if (!stale.length) return true;
  const epoch = view._tabRefreshEpoch;
  const siteId = view._siteId;
  const current = () =>
    view.isConnected &&
    view._siteId === siteId &&
    view._tabRefreshEpoch === epoch;
  let batch = view._tabRefreshBatch;
  if (!batch || batch.epoch !== epoch || batch.siteId !== siteId) {
    batch = { epoch, siteId, entries: new Map(), promise: null };
    view._tabRefreshBatch = batch;
  }
  for (const status of stale) {
    if (batch.entries.has(status)) continue;
    const entry = {
      promise: Promise.resolve(null),
    };
    entry.promise = listTasks({ status, limit: 50 })
      .then((result) => ({
        status,
        tasks: result.tasks || [],
        fetchedAt: Date.now(),
      }))
      .catch(() => null);
    batch.entries.set(status, entry);
    view._tabRefreshes.set(status, entry);
  }
  if (batch.promise) return batch.promise;
  batch.promise = (async () => {
    let count = -1;
    let results = [];
    // A tab switch can join more statuses while this batch is still loading.
    while (count !== batch.entries.size) {
      count = batch.entries.size;
      results = await Promise.all(
        [...batch.entries.values()].map((entry) => entry.promise),
      );
    }
    if (!current()) return false;
    return applyTaskLists(view, results);
  })().finally(() => {
    for (const [status, entry] of batch.entries) {
      if (view._tabRefreshes.get(status) === entry)
        view._tabRefreshes.delete(status);
    }
    if (view._tabRefreshBatch === batch) view._tabRefreshBatch = null;
  });
  return batch.promise;
}

/** The worklist statuses Home shows, in tab order (the backend's order too). */
export const HOME_TASK_STATUSES = /** @type {const} */ ([
  "open",
  "in_progress",
  "completing",
  "completed",
]);

/**
 * Apply the `tasks` sections of a `GET /v1/home` response: one timestamp for
 * every list, and a section with `ok: false` treated exactly like a failed
 * per-status request (its list keeps its old rows and freshness).
 * @param {any} view
 * @param {Record<string, { ok: boolean, items?: any[] }> | undefined} sections
 * @param {number} fetchedAt
 * @returns {boolean} true when every section applied
 */
export function applyHomeTaskSections(view, sections, fetchedAt) {
  return applyTaskLists(
    view,
    HOME_TASK_STATUSES.map((status) =>
      sections?.[status]?.ok
        ? { status, tasks: sections[status].items || [], fetchedAt }
        : null,
    ),
  );
}

/**
 * Merge freshly read status lists into the Home model and re-render once.
 * `results` holds `{ status, tasks, fetchedAt }` per list, or null for a list
 * whose read failed. Shared by the targeted per-status refresh above and the
 * one-request Home refresh.
 * @param {any} view
 * @param {Array<{ status: string, tasks: any[], fetchedAt: number } | null>} results
 * @returns {boolean} true when every list in `results` was applied
 */
export function applyTaskLists(view, results) {
  const succeeded = results.filter(Boolean);
  if (!succeeded.length) return false;
  const refreshed = new Set(succeeded.map((result) => result.status));
  const incoming = succeeded.flatMap((result) => result.tasks);
  // An observed saved version retires the local override. Missing/older index
  // rows are not proof that a confirmed mutation has disappeared.
  for (const task of incoming) {
    const confirmed = view._confirmedTasks?.get(task.taskId);
    if (
      confirmed &&
      task.updatedAt &&
      confirmed.updatedAt &&
      (task.updatedAt > confirmed.updatedAt ||
        (task.updatedAt === confirmed.updatedAt &&
          task.status === confirmed.status))
    )
      view._confirmedTasks.delete(task.taskId);
  }
  const byId = new Map();
  for (const task of [
    ...view._homeModel.tasks.filter((task) => !refreshed.has(task.status)),
    ...incoming,
  ]) {
    const previous = byId.get(task.taskId);
    if (
      !previous ||
      !previous.updatedAt ||
      !task.updatedAt ||
      task.updatedAt >= previous.updatedAt
    )
      byId.set(task.taskId, task);
  }
  const tasks = view._reconcileConfirmedTasks([...byId.values()]);
  const previousVersions = view._homeModel.tasks
    .map((task) => JSON.stringify([task.taskId, duplicateTaskVersion(task)]))
    .sort()
    .join();
  const nextVersions = tasks
    .map((task) => JSON.stringify([task.taskId, duplicateTaskVersion(task)]))
    .sort()
    .join();
  for (const result of succeeded)
    view._taskListFreshness.set(result.status, result.fetchedAt);
  const secondary = ["in_progress", "completing", "completed"];
  if (secondary.every((status) => view._taskListFreshness.has(status)))
    view._remainingStatus = "loaded";
  const active = document.activeElement;
  const taskId = active
    ?.closest?.("[data-task-id]")
    ?.getAttribute("data-task-id");
  const action = active?.getAttribute("data-action");
  const filter = active?.getAttribute("data-home-filter");
  const scroll = { left: window.scrollX, top: window.scrollY };
  view._renderHome(
    { ...view._homeModel, tasks },
    { preserveInteraction: true },
  );
  if (active && !active.isConnected) {
    const selector =
      taskId && action
        ? `[data-task-id="${CSS.escape(taskId)}"] [data-action="${CSS.escape(action)}"]`
        : filter
          ? `[data-home-filter="${CSS.escape(filter)}"]`
          : null;
    if (selector) view.querySelector(selector)?.focus({ preventScroll: true });
  }
  window.scrollTo?.(scroll);
  if (previousVersions !== nextVersions) view._watchDuplicates(tasks);
  void view._hydrateVisibleHomeTasks();
  return succeeded.length === results.length;
}

/** @param {string} tab */
function neededStatuses(tab) {
  switch (normalizedHomeTab(tab)) {
    case "todo":
      return ["open"];
    case "in_progress":
      return ["in_progress", "completing", "completed"];
    default:
      return ["open", "in_progress", "completing", "completed"];
  }
}
