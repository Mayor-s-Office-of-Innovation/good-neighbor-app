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

/**
 * Remove presentation overrides when the server restores an independent issue.
 * @param {...string} taskIds
 */
export function clearTaskStatusOverrides(...taskIds) {
  const overrides = readTaskStatusOverrides();
  for (const taskId of taskIds) delete overrides[taskId];
  writeTaskStatusOverrides(overrides);
  return overrides;
}

/**
 * Repair only overrides written before actions targeted the returned task.
 * Read storage again so a stale view cannot erase a newer action from another tab.
 * @param {...string} taskIds
 */
export function repairSeparatedTaskStatusOverrides(...taskIds) {
  const overrides = readTaskStatusOverrides();
  let changed = false;
  for (const taskId of taskIds) {
    const override = overrides[taskId];
    if (override?.status === "in_progress" && override?.version !== 1) {
      delete overrides[taskId];
      changed = true;
    }
  }
  if (changed) writeTaskStatusOverrides(overrides);
  return overrides;
}
