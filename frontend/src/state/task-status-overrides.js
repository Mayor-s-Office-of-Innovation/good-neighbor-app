/*
  task-status-overrides — a localStorage overlay of home bucket assignments
  ("in progress" / "resolved") the user set on a task before the backend has
  caught up. Losing it only affects the temporary home bucket assignment.
*/
const TASK_STATUS_OVERRIDES_KEY = "gnp-home-task-status-overrides";

export function readTaskStatusOverrides() {
  try {
    const raw = localStorage.getItem(TASK_STATUS_OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeTaskStatusOverrides(overrides) {
  try {
    localStorage.setItem(TASK_STATUS_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Losing this overlay only affects the temporary home bucket assignment.
  }
}
