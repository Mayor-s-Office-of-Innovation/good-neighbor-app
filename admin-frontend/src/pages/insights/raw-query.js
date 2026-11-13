// Raw data lists keep their filters and grouping in the URL, as Overview does.
import { periodApiParams, periodSearch } from "./insights-query.js";

/** @typedef {import("./insights-query.js").Period} Period */
/** @typedef {"issues" | "checks"} RawKind */
/** @typedef {ReturnType<typeof readRaw>} RawState */

// LIMITS.maxExportRows; a bigger export is refused, so the button says so first.
export const MAX_EXPORT_ROWS = 250_000;
// Free-text filters are IDs or names; anything longer is a crafted link.
const MAX_VALUE = 200;

// Who runs the Site first, then the City side that oversees it.
export const SITE_FILTERS = /** @type {const} */ ([
  "providerId",
  "department",
  "programId",
  "managerId",
]);

/**
 * What each filter offers, in screen order; null is free text. Every
 * value is one the server's LIST_FILTERS accepts.
 */
export const RECORD_FILTERS = {
  issues: {
    issueStatus: ["open", "resolved"],
    category: null,
    severityBand: ["severe", "moderate", "minor"],
    responseState: [
      "awaiting",
      "overdue",
      "onTime",
      "late",
      "notTimed",
      "unknown",
    ],
  },
  checks: {
    state: ["completed", "unfinished"],
  },
};

// Not offered, but a link may carry them, so they still filter.
export const LINK_ONLY = {
  severityBand: ["unknown"],
};

// Each grouping is a server sort, so a group never splits across pages out of order.
export const ISSUE_GROUPS = {
  latest: "latestActivityAt",
  created: "createdAt",
  site: "siteName",
};

/** @param {URLSearchParams} params @param {string} key @param {readonly string[] | null} allowed */
function pick(params, key, allowed) {
  const value = (params.get(key) || "").trim();
  if (!value || value.length > MAX_VALUE) return "";
  return !allowed || allowed.includes(value) ? value : "";
}

/** @param {RawKind} kind @param {string} search */
export function readRaw(kind, search) {
  const params = new URLSearchParams(search);
  /** @type {Record<string, string>} */
  const filters = {};
  for (const [key, offered] of Object.entries(RECORD_FILTERS[kind])) {
    const extra = /** @type {Record<string, string[]>} */ (LINK_ONLY)[key];
    filters[key] = pick(params, key, offered && [...offered, ...(extra ?? [])]);
  }
  for (const key of SITE_FILTERS) filters[key] = pick(params, key, null);
  return {
    // Not capped here: past the server's 100 the list fails and says so, rather than drop Sites unseen.
    siteIds: [
      ...new Set(
        (params.get("siteIds") || "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id && id.length <= MAX_VALUE),
      ),
    ],
    filters,
    group:
      kind === "issues"
        ? pick(params, "group", Object.keys(ISSUE_GROUPS)) || "latest"
        : "",
  };
}

/** @param {RawState} state */
export function isFiltered(state) {
  return state.siteIds.length > 0 || Object.values(state.filters).some(Boolean);
}

/** @param {RawKind} kind @param {RawState} state @param {Period | null} period @returns {string} "" or "?…" */
export function rawSearch(kind, state, period) {
  const params = periodSearch(period);
  if (state.siteIds.length) params.set("siteIds", state.siteIds.join(","));
  for (const [key, value] of Object.entries(state.filters))
    if (value) params.set(key, value);
  if (kind === "issues" && state.group !== "latest")
    params.set("group", state.group);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * @param {RawKind} kind
 * @param {RawState} state
 * @param {Period | null} period
 * @param {string} [cursor] the reply's nextCursor, for Load more
 */
export function rawApiParams(kind, state, period, cursor = "") {
  /** @type {Record<string, string>} */
  const params = { ...periodApiParams(period) };
  if (state.siteIds.length) params.siteIds = state.siteIds.join(",");
  for (const [key, value] of Object.entries(state.filters))
    if (value) params[key] = value;
  if (kind === "issues")
    params.sort =
      ISSUE_GROUPS[/** @type {keyof typeof ISSUE_GROUPS} */ (state.group)] ??
      ISSUE_GROUPS.latest;
  // Single problem reports list as Issues; mixing them in would break the Site page's Completed Checks count.
  else params.source = "perimeter";
  if (cursor) params.cursor = cursor;
  return params;
}

/**
 * The only place an export request is shaped, so a new download format
 * changes this and nothing else. Every matching row, not one page.
 * @param {RawKind} kind
 * @param {RawState} state
 * @param {Period | null} period
 */
export function exportBody(kind, state, period) {
  return { dataset: kind, ...rawApiParams(kind, state, period) };
}
