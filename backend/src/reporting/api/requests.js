// Every limit lives here, so no endpoint can be asked for more.

import { createHash } from "node:crypto";
import { pacificDateKey } from "../../lib/pacific-dates.js";
import { RESPONSE_STATES } from "../contract.js";
import { REQUEST_ERROR, resolvePeriod } from "../periods.js";

export const LIMITS = Object.freeze({
  pageSize: 50,
  maxPageSize: 100,
  maxSiteIds: 100,
  maxTrendSites: 50,
  maxReportSites: 10,
  // A year of citywide Issues is about 222,000 rows (architecture doc, decision 4).
  maxExportRows: 250_000,
  maxSearch: 100,
  maxFilterLength: 200,
  maxGroupValues: 50,
});

/** @typedef {Record<string, unknown>} Params query-string values, or a JSON body */

/**
 * @param {string} code
 * @param {number} [statusCode]
 * @returns {Error & { code: string, statusCode: number }}
 */
export function requestError(code, statusCode = 400) {
  return Object.assign(new Error(code), {
    code,
    statusCode,
    [REQUEST_ERROR]: true,
  });
}

// Only these are safe to show a caller; anything else may carry internals.
/**
 * @param {unknown} err
 * @returns {err is Error & { code: string, statusCode: number }}
 */
export function isRequestError(err) {
  return /** @type {any} */ (err)?.[REQUEST_ERROR] === true;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function str(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {number}
 */
function wholeNumber(value, code) {
  const text = typeof value === "number" ? String(value) : str(value);
  if (!text || !/^\d+$/.test(text)) throw requestError(code);
  return Number(text);
}

/**
 * @param {Params} params
 * @param {string} evaluatedAt
 * @returns {import("../periods.js").Interval}
 */
export function parsePeriodParams(params, evaluatedAt) {
  const kind = str(params.period) ?? "month";
  /** @type {import("../periods.js").PeriodSpec} */
  let spec;
  if (kind === "month")
    spec = {
      kind,
      month: str(params.month) ?? pacificDateKey(evaluatedAt).slice(0, 7),
    };
  else if (kind === "year")
    spec = { kind, year: wholeNumber(params.year, "invalid_year") };
  else if (kind === "financialYear")
    spec = { kind, startYear: wholeNumber(params.startYear, "invalid_year") };
  else if (kind === "custom")
    spec = {
      kind,
      startDay: str(params.from) ?? "",
      endDay: str(params.to) ?? "",
    };
  else throw requestError("invalid_period");
  return resolvePeriod(spec, evaluatedAt);
}

// A job keeps the month it was asked in, so a retry after the 1st builds the same month.
/**
 * @param {Params} params
 * @param {string} evaluatedAt
 * @returns {Params}
 */
export function withDefaultMonth(params, evaluatedAt) {
  if ((str(params.period) ?? "month") !== "month" || str(params.month))
    return params;
  return { ...params, month: pacificDateKey(evaluatedAt).slice(0, 7) };
}

/**
 * @param {unknown} value comma list or array of IDs
 * @param {number} max
 * @returns {string[]}
 */
export function parseIdList(value, max) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  // null or {} would become "null" or "[object Object]" and match nothing.
  if (!list || list.some((v) => typeof v !== "string"))
    throw requestError("invalid_site_ids");
  const ids = [...new Set(list.map((v) => v.trim()).filter(Boolean))];
  if (!ids.length || ids.some((id) => id.length > LIMITS.maxFilterLength))
    throw requestError("invalid_site_ids");
  if (ids.length > max) throw requestError("too_many_sites");
  return ids.sort();
}

// Only these, so a request can't filter or group by contact details.
export const SITE_DIMENSIONS = Object.freeze([
  "status",
  "siteType",
  "providerId",
  "programId",
  "department",
  "managerId",
]);

/**
 * @typedef {object} SiteFilter
 * @property {string[]} [siteIds]
 * @property {string} [q]
 * @property {string} [status]
 * @property {string} [siteType]
 * @property {string} [providerId]
 * @property {string} [programId]
 * @property {string} [department]
 * @property {string} [managerId]
 */

/**
 * @param {Params} params
 * @returns {SiteFilter}
 */
export function parseSiteFilter(params) {
  /** @type {SiteFilter} */
  const filter = {};
  if (params.siteIds !== undefined)
    filter.siteIds = parseIdList(params.siteIds, LIMITS.maxSiteIds);
  for (const dim of SITE_DIMENSIONS) {
    if (params[dim] === undefined) continue;
    const value = str(params[dim]);
    if (!value || value.length > LIMITS.maxFilterLength)
      throw requestError(`invalid_${dim}`);
    /** @type {Record<string, unknown>} */ (filter)[dim] = value;
  }
  if (params.q !== undefined) {
    const q = str(params.q)?.trim();
    if (q === undefined || q.length > LIMITS.maxSearch)
      throw requestError("invalid_q");
    if (q) filter.q = q;
  }
  return filter;
}

/** @typedef {"sites" | "issues" | "checks"} ListKind */

/** A fixed list, so every sort has a stable tie-break; first is default. */
export const SORTS = Object.freeze({
  sites: {
    name: "asc",
    overdueLate: "desc",
    maxSeverity: "desc",
    // Fewest first, since few Checks is the concern.
    completedPerimeterChecks: "asc",
    issuesCreated: "desc",
  },
  issues: {
    createdAt: "desc",
    latestActivityAt: "desc",
    severity: "desc",
    deadlineAt: "asc",
    siteName: "asc",
  },
  checks: { activityAt: "desc", siteName: "asc" },
});

/** Fixed values, so a typo is a 400, not an empty list; null is free text. */
const CONTACT_STATES = ["available", "missing", "unknown"];
export const LIST_FILTERS = Object.freeze({
  // Unlike SITE_DIMENSIONS, these need each Site's totals for the period.
  sites: {
    show: ["all", "top", "unknown"],
    responseState: RESPONSE_STATES,
    publicContact: CONTACT_STATES,
    siteContact: CONTACT_STATES,
  },
  issues: {
    severityBand: ["minor", "moderate", "severe", "unknown"],
    responseState: RESPONSE_STATES,
    source: ["perimeter", "single-problem", "unknown"],
    // Not "status": that name filters Sites.
    issueStatus: ["open", "resolved"],
    category: null,
  },
  checks: {
    state: ["completed", "unfinished"],
    source: ["perimeter", "single-problem"],
  },
});

/**
 * @typedef {object} ListQuery
 * @property {Record<string, string>} filters
 * @property {{ key: string, dir: "asc" | "desc" }} sort
 * @property {number} limit
 * @property {string | undefined} cursor
 */

/**
 * @param {ListKind} kind
 * @param {Params} params
 * @returns {ListQuery}
 */
export function parseListQuery(kind, params) {
  /** @type {Record<string, string>} */
  const sorts = SORTS[kind];
  const key = str(params.sort) ?? Object.keys(sorts)[0];
  if (!Object.hasOwn(sorts, key)) throw requestError("invalid_sort");
  const dir = str(params.dir) ?? sorts[key];
  if (dir !== "asc" && dir !== "desc") throw requestError("invalid_dir");
  /** @type {number} */
  let limit = LIMITS.pageSize;
  if (params.limit !== undefined) {
    limit = wholeNumber(params.limit, "invalid_limit");
    if (limit < 1 || limit > LIMITS.maxPageSize)
      throw requestError("invalid_limit");
  }
  /** @type {Record<string, ReadonlyArray<string> | null>} */
  const allowed = LIST_FILTERS[kind];
  /** @type {Record<string, string>} */
  const filters = {};
  for (const [name, values] of Object.entries(allowed)) {
    if (params[name] === undefined) continue;
    const value = str(params[name]);
    if (
      !value ||
      value.length > LIMITS.maxFilterLength ||
      (values && !values.includes(value))
    )
      throw requestError(`invalid_${name}`);
    filters[name] = value;
  }
  // A first-page link may send `cursor=` with nothing after it.
  const raw = params.cursor === "" ? undefined : params.cursor;
  const cursor = raw === undefined ? undefined : str(raw);
  if (raw !== undefined && !cursor) throw requestError("invalid_cursor");
  return { filters, sort: { key, dir }, limit, cursor };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortedKeys(/** @type {any} */ (value)[k])]),
    );
  return value;
}

/**
 * @param {unknown} query
 * @returns {string}
 */
export function queryHash(query) {
  return createHash("sha256")
    .update(JSON.stringify(sortedKeys(query)))
    .digest("hex")
    .slice(0, 24);
}

// Snapshots never change, so an offset into one stays a stable page.
/**
 * @param {unknown} query normalized query, without the cursor itself
 * @param {string} snapshotId
 * @param {number} offset
 * @returns {string}
 */
export function encodeCursor(query, snapshotId, offset) {
  return Buffer.from(
    JSON.stringify({ q: queryHash(query), s: snapshotId, o: offset }),
  ).toString("base64url");
}

/**
 * @param {string} cursor
 * @param {unknown} query
 * @param {string} snapshotId
 * @returns {number} offset
 */
export function decodeCursor(cursor, query, snapshotId) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw requestError("invalid_cursor");
  }
  if (!parsed || !Number.isInteger(parsed.o) || parsed.o < 0)
    throw requestError("invalid_cursor");
  // Checked before the hash: a new snapshot can move the default month, which
  // changes the hash. Rows may reorder too, so restart from page one.
  if (parsed.s !== snapshotId) throw requestError("snapshot_changed", 409);
  if (parsed.q !== queryHash(query))
    throw requestError("cursor_query_mismatch");
  return parsed.o;
}
