// Site insights rules with no page or network, so unit tests cover them alone.
import {
  overviewSearch,
  readOverview,
  readPeriod,
  samePeriod,
} from "./insights-query.js";

/** @typedef {import("./insights-query.js").Period} Period */
/** @typedef {{ state: string, reasonCodes: string[] }} ContactState */

/** @param {string} path */
export const isOverview = (path) =>
  path.split("?")[0].replace(/\/$/, "") === "/insights";

/**
 * Keeps Overview's filters but shows the period picked here, as the tabs do.
 * @param {string} path
 * @param {Period | null} period
 */
export function withPeriod(path, period) {
  const query = `?${path.split("?")[1] ?? ""}`;
  if (samePeriod(readPeriod(query), period)) return path;
  // Built as Overview builds its own URL, so Overview knows it on return.
  return `/insights${overviewSearch(readOverview(query), period)}`;
}

/**
 * Back goes to the Overview this Site came from, else the last one seen.
 * @param {{ asked: string, remembered: string, period: Period | null }} from
 */
export const backPath = ({ asked, remembered, period }) =>
  withPeriod(
    (isOverview(asked) && asked) ||
      (isOverview(remembered) && remembered) ||
      "/insights",
    period,
  );

/**
 * Overview finds its place by exact path, so a Back at another period is noted too.
 * @param {string} overviewPath
 * @param {string} back
 */
export const alsoPath = (overviewPath, back) =>
  back === overviewPath ? "" : back;

/**
 * Tile order, so the same picks make the same request.
 * @param {readonly string[]} order
 * @param {string} picked comma-separated, or ""
 * @param {string} tile
 * @param {boolean} [single] the tile replaces the pick, and pressing it again keeps it
 */
export function toggleTile(order, picked, tile, single = false) {
  if (single) return tile;
  const on = new Set(picked.split(",").filter(Boolean));
  if (!on.delete(tile)) on.add(tile);
  return order.filter((key) => on.has(key)).join(",");
}

/**
 * A concern's list replaces the tiles' filter until a tile is picked.
 * @param {string} param
 * @param {{ tile: string, concern: string }} state
 * @returns {Record<string, string>}
 */
export const listFilter = (param, { tile, concern }) =>
  concern ? { concern } : { [param]: tile };

/**
 * Checks always show their total; Issues per 30 days over 30 days is the total.
 * @param {string} key
 * @param {number} days
 */
export const showsTotal = (key, days) =>
  key === "completedPerimeterChecks" ||
  (key === "issuesCreated" && days !== 30);

/**
 * Today's Manage record, once read, gives both the details and their state,
 * so a fixed contact doesn't still read Missing from the stored report.
 * @param {"public" | "site"} kind
 * @param {ContactState & Record<string, any>} reported
 * @param {Record<string, string> | undefined} person
 * @param {boolean} read
 * @returns {ContactState & { person: Record<string, string> | undefined }}
 */
export function contactShown(kind, reported, person, read) {
  if (!read)
    return {
      person: reported,
      state: reported.state,
      reasonCodes: reported.reasonCodes,
    };
  if (kind === "site")
    return person &&
      (person.firstName || person.lastName || person.email || person.phone)
      ? { person, state: "available", reasonCodes: [] }
      : {
          person: undefined,
          state: "missing",
          reasonCodes: ["no_site_contact"],
        };
  const reasonCodes = [
    !person?.email && "no_email",
    !person?.phone && "no_phone",
  ].filter((code) => typeof code === "string");
  return {
    person,
    state: reasonCodes.length ? "missing" : "available",
    reasonCodes,
  };
}
