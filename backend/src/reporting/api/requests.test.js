import { describe, expect, it } from "vitest";
import { addDays, dayKeysBetween } from "../../lib/pacific-dates.js";
import {
  LIMITS,
  decodeCursor,
  encodeCursor,
  isRequestError,
  parseIdList,
  parseListQuery,
  parsePeriodParams,
  parseSiteFilter,
  queryHash,
  requestError,
} from "./requests.js";

const EVALUATED = "2026-11-04T19:00:00.000Z";
/**
 * Every day from `from` through `through`, as a snapshot's dataDays.
 * @param {string} from
 * @param {string} through
 */
const daysOfData = (from, through) => dayKeysBetween(from, addDays(through, 1));
// Data every day, from well before any month these tests ask for.
const LONG_RUNNING = daysOfData("2025-01-01", "2027-01-15");

/**
 * @param {() => unknown} fn
 * @returns {{ code?: string, statusCode?: number }}
 */
function errorOf(fn) {
  try {
    fn();
  } catch (err) {
    return /** @type {any} */ (err);
  }
  throw new Error("expected an error");
}

describe("isRequestError", () => {
  it("knows its own errors and the period parser's", () => {
    expect(isRequestError(requestError("bad_thing"))).toBe(true);
    expect(
      isRequestError(
        errorOf(() => parsePeriodParams({ month: "x" }, EVALUATED)),
      ),
    ).toBe(true);
  });

  it("won't show a caller another library's error that has a code and status", () => {
    const network = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
      statusCode: 502,
    });
    expect(isRequestError(network)).toBe(false);
  });
});

describe("parsePeriodParams", () => {
  it("defaults to the last full Pacific month even when UTC has moved on", () => {
    // 05:00 UTC on Nov 1 is still Oct 31 in San Francisco, so September is the last full month.
    expect(
      parsePeriodParams({}, "2026-11-01T05:00:00.000Z", LONG_RUNNING),
    ).toMatchObject({
      startDay: "2026-09-01",
    });
  });

  it("defaults to December in January", () => {
    expect(
      parsePeriodParams({}, "2027-01-15T20:00:00.000Z", LONG_RUNNING),
    ).toMatchObject({
      startDay: "2026-12-01",
      endDay: "2027-01-01",
    });
  });

  it("reads a quarter from its year and number", () => {
    expect(
      parsePeriodParams(
        { period: "quarter", year: "2026", quarter: "3" },
        EVALUATED,
        LONG_RUNNING,
      ),
    ).toMatchObject({ kind: "quarter", startDay: "2026-07-01" });
  });

  it.each([
    [{ period: "quarter", year: "2026" }, "invalid_quarter"],
    [{ period: "quarter", quarter: "3" }, "invalid_year"],
  ])("refuses %j with %s", (params, code) => {
    expect(() => parsePeriodParams(params, EVALUATED, LONG_RUNNING)).toThrow(
      expect.objectContaining({ code, statusCode: 400 }),
    );
  });

  it("accepts a custom period of exactly 12 months", () => {
    expect(
      parsePeriodParams(
        { period: "custom", from: "2025-01-01", to: "2026-01-01" },
        EVALUATED,
        LONG_RUNNING,
      ),
    ).toMatchObject({ startDay: "2025-01-01", endDay: "2026-01-01" });
  });

  it("defaults to the last full month before the snapshot's, which a link can still override", () => {
    expect(parsePeriodParams({}, EVALUATED, LONG_RUNNING)).toMatchObject({
      kind: "month",
      startDay: "2026-10-01",
      endDay: "2026-11-01",
      incomplete: false,
    });
    expect(
      parsePeriodParams(
        { period: "month", month: "2026-11" },
        EVALUATED,
        LONG_RUNNING,
      ),
    ).toMatchObject({ startDay: "2026-11-01", incomplete: true });
  });

  it("stays on last month while this month has fewer days of data", () => {
    // Nov 2, launch week: October holds Oct 26–31, six days; November two.
    expect(
      parsePeriodParams(
        {},
        "2026-11-02T19:00:00.000Z",
        daysOfData("2026-10-26", "2026-11-02"),
      ),
    ).toMatchObject({ startDay: "2026-10-01", endDay: "2026-11-01" });
    // Nov 4: still four days against October's six.
    expect(
      parsePeriodParams({}, EVALUATED, daysOfData("2026-10-26", "2026-11-04")),
    ).toMatchObject({ startDay: "2026-10-01" });
  });

  it("opens on the running month once it has as many days of data as a short last month", () => {
    // Nov 6: six days in each.
    expect(
      parsePeriodParams(
        {},
        "2026-11-06T19:00:00.000Z",
        daysOfData("2026-10-26", "2026-11-06"),
      ),
    ).toMatchObject({
      kind: "month",
      startDay: "2026-11-01",
      endDay: "2026-12-01",
      incomplete: true,
    });
  });

  it("counts only days that have data, not the days since the data began", () => {
    // Data began Oct 1 but only Oct 1 and Oct 30–31 have any: 3 days.
    expect(
      parsePeriodParams({}, EVALUATED, [
        "2026-10-01",
        "2026-10-30",
        "2026-10-31",
        ...daysOfData("2026-11-01", "2026-11-04"),
      ]),
    ).toMatchObject({ startDay: "2026-11-01" });
  });

  it("opens on last month once it has 14 days of data", () => {
    // October holds Oct 18–31: exactly 14 days, though November has 30.
    expect(
      parsePeriodParams(
        {},
        "2026-11-30T19:00:00.000Z",
        daysOfData("2026-10-18", "2026-11-30"),
      ),
    ).toMatchObject({ startDay: "2026-10-01", endDay: "2026-11-01" });
  });

  it("opens on the running month when there's no data yet", () => {
    expect(parsePeriodParams({}, EVALUATED, [])).toMatchObject({
      startDay: "2026-11-01",
    });
  });

  it("opens a linked month as asked, even in launch week", () => {
    expect(
      parsePeriodParams(
        { period: "month", month: "2026-11" },
        EVALUATED,
        daysOfData("2026-10-26", "2026-11-04"),
      ),
    ).toMatchObject({ startDay: "2026-11-01", endDay: "2026-12-01" });
  });

  it("reads a July–June year from its start year", () => {
    expect(
      parsePeriodParams(
        { period: "financialYear", startYear: "2025" },
        EVALUATED,
        LONG_RUNNING,
      ),
    ).toMatchObject({ startDay: "2025-07-01", endDay: "2026-07-01" });
  });

  it("reads a custom period with an exclusive end day", () => {
    expect(
      parsePeriodParams(
        { period: "custom", from: "2026-01-01", to: "2026-03-01" },
        EVALUATED,
        LONG_RUNNING,
      ),
    ).toMatchObject({ startDay: "2026-01-01", endDay: "2026-03-01" });
  });

  it("refuses a custom period over 12 months as a 400", () => {
    expect(
      errorOf(() =>
        parsePeriodParams(
          { period: "custom", from: "2025-01-01", to: "2026-01-02" },
          EVALUATED,
          LONG_RUNNING,
        ),
      ),
    ).toMatchObject({ code: "period_too_long", statusCode: 400 });
  });

  it("refuses a year that isn't a whole number", () => {
    expect(
      errorOf(() =>
        parsePeriodParams(
          { period: "year", year: "2026.5" },
          EVALUATED,
          LONG_RUNNING,
        ),
      ),
    ).toMatchObject({ code: "invalid_year", statusCode: 400 });
  });
});

describe("parseSiteFilter", () => {
  it("splits a comma list of Site IDs and drops repeats", () => {
    expect(parseSiteFilter({ siteIds: "s2,s1,s2" }).siteIds).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("takes an array of Site IDs from a JSON body", () => {
    expect(parseSiteFilter({ siteIds: ["s1"] }).siteIds).toEqual(["s1"]);
  });

  it("refuses more Site IDs than the limit", () => {
    const ids = Array.from(
      { length: LIMITS.maxSiteIds + 1 },
      (_, i) => `s${i}`,
    );
    expect(
      errorOf(() => parseSiteFilter({ siteIds: ids.join(",") })),
    ).toMatchObject({ code: "too_many_sites", statusCode: 400 });
  });

  it("refuses an empty Site ID list rather than reading it as every Site", () => {
    expect(errorOf(() => parseSiteFilter({ siteIds: "" }))).toMatchObject({
      code: "invalid_site_ids",
    });
  });

  it("keeps only the filters it knows", () => {
    expect(
      parseSiteFilter({ department: "Public Works", sql: "drop" }),
    ).toEqual({ department: "Public Works" });
  });

  it("refuses an over-long search", () => {
    expect(
      errorOf(() => parseSiteFilter({ q: "x".repeat(LIMITS.maxSearch + 1) })),
    ).toMatchObject({ code: "invalid_q" });
  });
});

describe("parseListQuery", () => {
  it("uses each list's default sort and page size", () => {
    expect(parseListQuery("issues", {})).toMatchObject({
      sort: { key: "createdAt", dir: "desc" },
      limit: LIMITS.pageSize,
    });
  });

  it("sorts Sites by Checks fewest first, unless asked otherwise", () => {
    const sort = (/** @type {Record<string, string>} */ params) =>
      parseListQuery("sites", { sort: "completedPerimeterChecks", ...params })
        .sort.dir;
    expect([sort({}), sort({ dir: "desc" })]).toEqual(["asc", "desc"]);
  });

  it("refuses a sort the list doesn't offer", () => {
    expect(
      errorOf(() => parseListQuery("checks", { sort: "severity" })),
    ).toMatchObject({ code: "invalid_sort", statusCode: 400 });
  });

  it("refuses a page larger than the maximum", () => {
    expect(
      errorOf(() =>
        parseListQuery("issues", { limit: String(LIMITS.maxPageSize + 1) }),
      ),
    ).toMatchObject({ code: "invalid_limit" });
  });

  it("refuses a filter value outside its list", () => {
    expect(
      errorOf(() => parseListQuery("issues", { responseState: "passed" })),
    ).toMatchObject({ code: "invalid_responseState" });
  });

  it("keeps a valid Issue filter", () => {
    expect(
      parseListQuery("issues", { severityBand: "severe" }).filters,
    ).toEqual({ severityBand: "severe" });
  });

  it("keeps Overview's concern and indicator filters", () => {
    expect(
      parseListQuery("sites", {
        show: "top",
        responseState: "overdue",
        publicContact: "missing",
        siteContact: "unknown",
      }).filters,
    ).toEqual({
      show: "top",
      responseState: "overdue",
      publicContact: "missing",
      siteContact: "unknown",
    });
  });

  it("refuses a contact state that isn't one of the three", () => {
    expect(
      errorOf(() => parseListQuery("sites", { siteContact: "compliant" })),
    ).toMatchObject({ code: "invalid_siteContact" });
  });
});

describe("cursors", () => {
  const query = { kind: "issues", filters: {}, sort: "createdAt" };

  it("gives the same hash for the same query in any key order", () => {
    expect(queryHash({ b: 1, a: { d: 2, c: 3 } })).toBe(
      queryHash({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("reads back the offset it was given", () => {
    const cursor = encodeCursor(query, "snap1", 50);
    expect(decodeCursor(cursor, query, "snap1")).toBe(50);
  });

  it("refuses a cursor from a different query", () => {
    const cursor = encodeCursor(query, "snap1", 50);
    expect(
      errorOf(() =>
        decodeCursor(cursor, { ...query, sort: "severity" }, "snap1"),
      ),
    ).toMatchObject({ code: "cursor_query_mismatch", statusCode: 400 });
  });

  it("refuses a cursor from an older snapshot, so pages never mix", () => {
    const cursor = encodeCursor(query, "snap1", 50);
    expect(errorOf(() => decodeCursor(cursor, query, "snap2"))).toMatchObject({
      code: "snapshot_changed",
      statusCode: 409,
    });
  });

  it("says the snapshot changed, not the query, when both did", () => {
    // A new snapshot can move the default month, changing the hash too.
    const cursor = encodeCursor(query, "snap1", 50);
    expect(
      errorOf(() => decodeCursor(cursor, { ...query, sort: "x" }, "snap2")),
    ).toMatchObject({ code: "snapshot_changed", statusCode: 409 });
  });

  it("treats an empty cursor as the first page", () => {
    expect(parseListQuery("issues", { cursor: "" }).cursor).toBeUndefined();
  });

  it("refuses a cursor it can't read", () => {
    expect(errorOf(() => decodeCursor("%%%", query, "snap1"))).toMatchObject({
      code: "invalid_cursor",
      statusCode: 400,
    });
  });
});

describe("parseIdList", () => {
  it.each([[[null]], [[{}]], [[["a", "b"]]], [[7]]])(
    "refuses %j, which would match no Site",
    (value) => {
      expect(errorOf(() => parseIdList(value, 10))).toMatchObject({
        code: "invalid_site_ids",
      });
    },
  );

  it("reads a comma list the same as an array", () => {
    expect(parseIdList("s2, s1", 10)).toEqual(parseIdList(["s1", "s2"], 10));
  });
});
