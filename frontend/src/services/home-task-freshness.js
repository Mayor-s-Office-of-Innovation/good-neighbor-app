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
  const tab = normalizedHomeTab(view._homeFilter);
  const statuses =
    tab === "todo"
      ? ["open"]
      : tab === "in_progress"
        ? ["in_progress", "completing", "completed"]
        : ["open", "in_progress", "completing", "completed", "cannot_do"];
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
  await Promise.all(
    stale.map((status) => {
      if (view._tabRefreshes.has(status))
        return view._tabRefreshes.get(status).promise;
      const entry = { promise: Promise.resolve(), visible: false };
      const timer = setTimeout(() => {
        if (!current()) return;
        entry.visible = true;
        view._tabRefreshStatus();
      }, 300);
      entry.promise = listTasks({ status, limit: 50 })
        .then((result) => {
          if (!current()) return;
          const incoming = result.tasks || [];
          const ids = new Set(incoming.map((task) => task.taskId));
          const tasks = [
            ...view._homeModel.tasks.filter(
              (task) => task.status !== status && !ids.has(task.taskId),
            ),
            ...incoming,
          ];
          const previousIds = view._homeModel.tasks
            .map((task) => task.taskId)
            .sort()
            .join();
          const nextIds = tasks
            .map((task) => task.taskId)
            .sort()
            .join();
          view._taskListFreshness.set(status, Date.now());
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
        })
        .catch(() => {
          // Keep the cached list and stale timestamp; the next return can retry.
        })
        .finally(() => {
          clearTimeout(timer);
          if (view._tabRefreshes.get(status) === entry)
            view._tabRefreshes.delete(status);
          if (current()) view._tabRefreshStatus();
        });
      view._tabRefreshes.set(status, entry);
      return entry.promise;
    }),
  );
}
