import { t } from "../i18n/i18n.js";
import {
  formatNumericDate,
  formatWeekday,
  pacificDateKey,
  pacificDaysAgo,
  pacificWeekdayIndex,
} from "../i18n/dates.js";
export const CARE_WORK_TYPES = [
  "power_washed",
  "called_hauler",
  "cleaned_graffiti",
  "offered_help",
  "referred_non_client",
  "called_shelter",
  "addressed_client_issue",
];
export const MAX_CARE_PHOTOS = 5;
/** @param {{ kind: string, note: string }} work */
export function careTitle(work) {
  return work.kind === "other" ? work.note : careKindLabel(work.kind);
}
/** @param {string} date @param {Date} [now] */
export function careDay(date, now = new Date()) {
  const days = pacificDaysAgo(date, now);
  if (days === 0) return t("card.history.today");
  if (days === 1) return t("card.history.yesterday");
  if (days > 1 && days <= (pacificWeekdayIndex(now) + 6) % 7)
    return formatWeekday(date);
  return formatNumericDate(date);
}
/** @param {Array<any>} items */
export function groupCareWork(items) {
  const groups = new Map();
  for (const item of [...items].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.workId.localeCompare(a.workId),
  )) {
    const day = pacificDateKey(item.createdAt);
    if (!groups.has(day))
      groups.set(day, { day, label: careDay(item.createdAt), items: [] });
    groups.get(day).items.push(item);
  }
  return [...groups.values()];
}

/** @param {string} kind */
export function careKindLabel(kind) {
  return t(
    `care.kind.${kind.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}`,
  );
}
