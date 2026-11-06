import { t } from "../i18n/i18n.js";
import {
  formatDateTime,
  formatMonthDayTime,
  formatTime,
  formatWeekday,
  pacificDaysAgo,
  pacificWeekdayIndex,
} from "../i18n/dates.js";

export function formatPacificUpdated(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const daysAgo = pacificDaysAgo(date, now) ?? 0;
  const daysSinceMonday = ((pacificWeekdayIndex(now) ?? 0) + 6) % 7;
  const day =
    daysAgo === 0
      ? t("date.today")
      : daysAgo === 1
        ? t("date.yesterday")
        : daysAgo >= 0 && daysAgo <= daysSinceMonday
          ? formatWeekday(date)
          : formatDateTime(date, {
              month: "2-digit",
              day: "2-digit",
              year: "numeric",
            });
  return t("taskUpdate.updatedAt", { day, time: formatTime(date) });
}

export function formatPacificDateTime(value) {
  if (!value) return "";
  return formatMonthDayTime(value);
}

/**
 * Catalog key for a City note's state on the timeline, or "" when there is
 * nothing to say. `unknown` reads as still sending: the worker may be retrying,
 * and once it stops an operator follows up, so the note may well have arrived.
 * @param {unknown} status the update's `cityNoteStatus`
 */
export function cityNoteLabelKey(status) {
  if (status === "failed") return "taskUpdate.cityNote.failed";
  if (status === "pending" || status === "sending" || status === "unknown")
    return "taskUpdate.cityNote.sending";
  return "";
}

/** @param {Record<string, any>} update */
export function cityNoteInFlight(update) {
  return (
    cityNoteLabelKey(update?.cityNoteStatus) === "taskUpdate.cityNote.sending"
  );
}
