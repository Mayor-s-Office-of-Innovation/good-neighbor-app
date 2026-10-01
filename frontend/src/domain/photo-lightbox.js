import { firstLocationLine } from "./ticket-detail.js";

const PACIFIC = "America/Los_Angeles";

function dateParts(value) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: PACIFIC,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(new Date(value))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, part]),
  );
}

function dayNumber(value) {
  const parts = dateParts(value);
  return Math.floor(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) /
      86_400_000,
  );
}

/**
 * Format photo timestamps in Pacific time using the app's calendar-week rules.
 * @param {string | number | Date} value
 * @param {string | number | Date} [now]
 */
export function formatPhotoDateTime(value, now = new Date()) {
  const date = new Date(value);
  const currentDate = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(currentDate.getTime()))
    return "";
  const photo = dateParts(date);
  const current = dateParts(currentDate);
  const daysAgo = dayNumber(currentDate) - dayNumber(date);
  const weekdayIndex = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ].indexOf(current.weekday);
  const daysSinceMonday = (weekdayIndex + 6) % 7;
  const label =
    daysAgo === 0
      ? "Today"
      : daysAgo === 1
        ? "Yesterday"
        : daysAgo >= 0 && daysAgo <= daysSinceMonday
          ? photo.weekday
          : `${String(photo.month).padStart(2, "0")}/${String(photo.day).padStart(2, "0")}/${photo.year}`;
  return `${label}, ${photo.hour}:${photo.minute} ${photo.dayPeriod}`;
}

/** @param {string} georeferencedAddress @param {string} siteAddress */
export function photoLocation(georeferencedAddress, siteAddress) {
  return firstLocationLine(georeferencedAddress || siteAddress);
}
