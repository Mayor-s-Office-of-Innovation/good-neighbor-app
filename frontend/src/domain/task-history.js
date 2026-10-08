import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import {
  formatMonthDay,
  formatWeekday,
  pacificDaysAgo,
  pacificDateKey,
  pacificWeekdayIndex,
} from "../i18n/dates.js";
import { taskCreatedAt } from "./home-tasks.js";

export function historyEnteredAt(task) {
  return (
    [
      task.resolvedAt,
      task.resolved_at,
      task.completedAt,
      task.completed_at,
      task.cannotDo?.recordedAt,
      task.historyEnteredAt,
      task.updatedAt,
      task.updated_at,
    ].find((value) => value && Number.isFinite(new Date(value).getTime())) || ""
  );
}

export function historyDuration(task) {
  const start = task.createdAt || task.created_at;
  const end = historyEnteredAt(task);
  if (!start || !end) return "";
  const minutes = Math.floor(
    (new Date(end).getTime() - new Date(start).getTime()) / 60000,
  );
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  if (minutes < 1) return t("card.history.lessThanMinute");
  if (minutes < 60) return t("card.history.minutes", { count: minutes });
  if (minutes < 1440)
    return t("card.history.hours", { count: Math.floor(minutes / 60) });
  if (minutes < 10080)
    return t("card.history.days", { count: Math.floor(minutes / 1440) });
  return t("card.history.overWeek");
}

export function historyDayLabel(date, now = new Date()) {
  if (!date) return t("card.history.unknownDate");
  const days = pacificDaysAgo(date, now);
  if (days === null) return t("card.history.unknownDate");
  const daysSinceMonday = ((pacificWeekdayIndex(now) ?? 0) + 6) % 7;
  if (days < 0 || (days > 1 && days > daysSinceMonday))
    return formatMonthDay(date);
  const day =
    days === 0
      ? t("card.history.today")
      : days === 1
        ? t("card.history.yesterday")
        : formatWeekday(date);
  return `${day} · ${formatMonthDay(date)}`;
}

export function groupHistory(entries, mode = "resolved") {
  const groups = new Map();
  for (const entry of entries) {
    const date =
      mode === "opened"
        ? taskCreatedAt(entry.task)
        : historyEnteredAt(entry.task);
    const key =
      mode === "type"
        ? entry.task.category || ""
        : date
          ? pacificDateKey(date)
          : "";
    if (!groups.has(key))
      groups.set(key, {
        key,
        title:
          mode === "type"
            ? rulebookText(key) || t("card.title.fallback")
            : historyDayLabel(date),
        entries: [],
      });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()]
    .sort((a, b) =>
      mode === "type"
        ? a.title.localeCompare(b.title)
        : b.key.localeCompare(a.key),
    )
    .map((group) => ({
      ...group,
      entries: group.entries.sort(
        (a, b) =>
          historyEnteredAt(b.task).localeCompare(historyEnteredAt(a.task)) ||
          String(a.task.taskId).localeCompare(String(b.task.taskId)),
      ),
    }));
}
