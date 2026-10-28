import { t } from "../i18n/i18n.js";
import { listTasks } from "./api.js";
import { normalizedHomeTab } from "../domain/home-tasks.js";

// UI tabs overlap backend statuses: completed 311 tasks can still be in
// progress, and expired open/in-progress tasks belong to History.
/** @param {any} view */
export async function refreshActiveTab(view) {
  if (
    !view.isConnected ||
    document.visibilityState === "hidden" ||
    !view._homeModel ||
    view._homeRefresh ||
    view._remainingRefresh
  )
    return;
  view._tabRefreshStatus = () => {
    const status = view.querySelector?.("[data-task-refresh-status]");
    if (status)
      status.textContent = [...view._tabRefreshes.values()].some(
        (entry) => entry.visible,
      )
        ? t("home.checkingUpdates")
        : "";
  };
  view._tabListStatus = () =>
    neededStatuses(view._homeFilter).every((status) =>
      view._taskListFreshness.has(status),
    )
      ? "loaded"
      : view._remainingStatus;
  const statuses = neededStatuses(view._homeFilter);
  const stale = statuses.filter(
    (status) =>
      Date.now() - (view._taskListFreshness.get(status) || 0) >= 5 * 60 * 1000,
  );
  if (!stale.length) return;
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
      visible: false,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      if (!current()) return;
      entry.visible = true;
      view._tabRefreshStatus();
    }, 300);
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
    if (!current()) return;
    const succeeded = results.filter(Boolean);
    if (!succeeded.length) return;
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
    const previousIds = view._homeModel.tasks
      .map((task) => task.taskId)
      .sort()
      .join();
    const nextIds = tasks
      .map((task) => task.taskId)
      .sort()
      .join();
    for (const result of succeeded)
      view._taskListFreshness.set(result.status, result.fetchedAt);
    const secondary = ["in_progress", "completing", "completed"];
    if (secondary.every((status) => view._taskListFreshness.has(status))) {
      view._remainingStatus = "loaded";
      view._remainingLoadedAt = Math.min(
        ...secondary.map((status) => view._taskListFreshness.get(status)),
      );
    }
    const active = document.activeElement;
    const taskId = active
      ?.closest?.("[data-task-id]")
      ?.getAttribute("data-task-id");
    const action = active?.getAttribute("data-action");
    const filter = active?.getAttribute("data-home-filter");
    const scroll = { left: window.scrollX, top: window.scrollY };
    view._renderHome({ ...view._homeModel, tasks });
    if (active && !active.isConnected) {
      const selector =
        taskId && action
          ? `[data-task-id="${CSS.escape(taskId)}"] [data-action="${CSS.escape(action)}"]`
          : filter
            ? `[data-home-filter="${CSS.escape(filter)}"]`
            : null;
      if (selector)
        view.querySelector(selector)?.focus({ preventScroll: true });
    }
    window.scrollTo?.(scroll);
    if (previousIds !== nextIds) view._watchDuplicates(tasks);
    void view._hydrateVisibleHomeTasks();
  })().finally(() => {
    for (const [status, entry] of batch.entries) {
      clearTimeout(entry.timer);
      if (view._tabRefreshes.get(status) === entry)
        view._tabRefreshes.delete(status);
    }
    if (view._tabRefreshBatch === batch) view._tabRefreshBatch = null;
    if (current()) view._tabRefreshStatus();
  });
  return batch.promise;
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
