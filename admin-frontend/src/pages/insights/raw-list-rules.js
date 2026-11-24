// Raw data list rules, apart from the element so they're unit-tested.
import { INSIGHTS_ROUTES } from "./insights-routes.js";
import { MAX_EXPORT_ROWS } from "./raw-query.js";

/** @typedef {import("./insights-session.js").RawMemory} RawMemory */

// Asking again with the same cursor fails the same way.
const RESTART_PAGING = new Set([
  "snapshot_changed",
  "invalid_cursor",
  "cursor_query_mismatch",
]);

/** @param {unknown} code a failed page's error code */
export const restartsPaging = (code) =>
  typeof code === "string" && RESTART_PAGING.has(code);

const LISTS = new Set(["insights-issues", "insights-checks"]);

/** @param {string} pathname */
export const isListPath = (pathname) =>
  INSIGHTS_ROUTES.some(
    ([name, pattern]) => LISTS.has(name) && pattern.test(pathname),
  );

/**
 * Only a way back to the same list shows the rows left; any other visit
 * loads fresh, so its data is current.
 * @param {RawMemory} memory
 * @param {string} here this list's path and query
 * @param {boolean} back browser Back, or a record's crumb, led here
 */
export const restores = (memory, here, back) =>
  back && memory.path === here && !!memory.reply;

/** @param {number | null} total null while unknown */
export const exportOff = (total) => !total || total > MAX_EXPORT_ROWS;
