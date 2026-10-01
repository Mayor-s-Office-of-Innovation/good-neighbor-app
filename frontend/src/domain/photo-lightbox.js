import { formatPacificUpdated } from "./task-updates.js";
import { firstLocationLine } from "./ticket-detail.js";

/**
 * Format photo timestamps in Pacific time using the app's calendar-week rules.
 * @param {string | number | Date} value
 * @param {string | number | Date} [now]
 */
export function formatPhotoDateTime(value, now = new Date()) {
  const currentDate = new Date(now);
  if (Number.isNaN(currentDate.getTime())) return "";
  const formatted = formatPacificUpdated(value, currentDate).replace(
    "Updated ",
    "",
  );
  return formatted.replace(/^(today|yesterday)/, (label) =>
    label.replace(/^./, (first) => first.toUpperCase()),
  );
}

/** @param {string} georeferencedAddress @param {string} siteAddress */
export function photoLocation(georeferencedAddress, siteAddress) {
  return firstLocationLine(georeferencedAddress || siteAddress);
}
