// Overview's selection and way-back rules, apart from the element so they're unit-tested.
import { MAX_REPORT_SITES } from "./insights-query.js";

/**
 * Picks come back only with the view they were made on; a new period has other rows.
 * @param {{ path: string, alsoPath?: string, selected: string[] }} back
 * @param {string} here
 * @returns {{ selected: string[], returning: boolean }}
 */
export function arrival(back, here) {
  const same = back.path === here;
  return {
    selected: same ? [...back.selected] : [],
    returning: same || (!!back.alsoPath && back.alsoPath === here),
  };
}

/**
 * Keeps the user's own picks first, in the order they made them.
 * @param {string[]} mine
 * @param {string[]} listedIds
 * @param {boolean} on
 */
export function pickAll(mine, listedIds, on) {
  if (!on) return [];
  const picked = new Set(mine);
  return [...mine, ...listedIds.filter((id) => !picked.has(id))].slice(
    0,
    MAX_REPORT_SITES,
  );
}

/**
 * @param {string[]} selected
 * @param {string} siteId
 * @param {boolean} on
 */
export function pickOne(selected, siteId, on) {
  const rest = selected.filter((id) => id !== siteId);
  return on ? [...rest, siteId] : rest;
}

/**
 * The Site to focus when Overview shows the view it was left from, else "".
 * @param {{ siteId: string, path: string, alsoPath?: string }} back
 * @param {string} here
 */
export function siteToFocus(back, here) {
  return back.siteId && (back.path === here || back.alsoPath === here)
    ? back.siteId
    : "";
}

// Drawing every row took about half a second at 500 Sites, so the table grows by Load more.
export const SITES_PAGE = 50;

/**
 * A page of rows, or enough to reach the Site the user came back from.
 * @param {string[]} listedIds
 * @param {string} siteId
 */
export function rowsToShow(listedIds, siteId) {
  const at = siteId ? listedIds.indexOf(siteId) : -1;
  return Math.max(1, Math.ceil((at + 1) / SITES_PAGE)) * SITES_PAGE;
}

/** Any other click opens the link's own address, as links do. @param {MouseEvent} event */
export const plainClick = (event) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
