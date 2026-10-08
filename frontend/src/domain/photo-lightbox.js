import { firstLocationLine } from "./ticket-detail.js";
import { t } from "../i18n/i18n.js";
import {
  formatDateTime,
  formatTime,
  formatWeekday,
  pacificDaysAgo,
  pacificWeekdayIndex,
} from "../i18n/dates.js";

/**
 * Format photo timestamps in Pacific time using the app's calendar-week rules:
 * today / yesterday, the weekday name inside the current Monday-based week, a
 * numeric date before that. The wording comes from the catalog and the time /
 * weekday names from the active locale (same rules as task-updates.js).
 * @param {string | number | Date} value
 * @param {string | number | Date} [now]
 */
export function formatPhotoDateTime(value, now = new Date()) {
  const currentDate = new Date(now);
  if (Number.isNaN(currentDate.getTime())) return "";
  const daysAgo = pacificDaysAgo(value, currentDate);
  if (daysAgo === null) return "";
  const time = formatTime(value);
  if (daysAgo === 0) return t("card.time.today", { time });
  if (daysAgo === 1) return t("lightbox.time.yesterday", { time });
  const daysSinceMonday = ((pacificWeekdayIndex(currentDate) ?? 0) + 6) % 7;
  if (daysAgo >= 0 && daysAgo <= daysSinceMonday) {
    return t("lightbox.time.weekday", { day: formatWeekday(value), time });
  }
  return t("card.time.date", {
    date: formatDateTime(value, {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    }),
    time,
  });
}

/** @param {string} georeferencedAddress @param {string} siteAddress */
export function photoLocation(georeferencedAddress, siteAddress) {
  return firstLocationLine(georeferencedAddress || siteAddress);
}
