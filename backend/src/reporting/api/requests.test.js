import { describe, expect, it } from "vitest";
import {
  LIMITS,
  decodeCursor,
  encodeCursor,
  parseIdList,
  parseListQuery,
  parsePeriodParams,
  parseSiteFilter,
  queryHash,
} from "./requests.js";

const EVALUATED = "2026-11-04T19:00:00.000Z";

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

describe("parsePeriodParams", () => {
  it("defaults to the Pacific month even when UTC has moved on", () => {
    // 05:00 UTC on Nov 1 is still Oct 31 in San Francisco.
    expect(parsePeriodParams({}, "2026-11-01T05:00:00.000Z")).toMatchObject({
      startDay: "2026-10-01",
    });
  });

  it("accepts a custom period of exactly 12 months", () => {
    expect(
      parsePeriodParams(
        { period: "custom", from: "2025-01-01", to: "2026-01-01" },
        EVALUATED,
      ),
    ).toMatchObject({ startDay: "2025-01-01", endDay: "2026-01-01" });
  });

  it("defaults to the snapshot's current Pacific month", () => {
    expect(parsePeriodParams({}, EVALUATED)).toMatchObject({
      kind: "month",
      startDay: "2026-11-01",
      endDay: "2026-12-01",
      incomplete: true,
    });
  });

  it("reads a July–June year from its start year", () => {
    expect(
      parsePeriodParams(
        { period: "financialYear", startYear: "2025" },
        EVALUATED,
      ),
    ).toMatchObject({ startDay: "2025-07-01", endDay: "2026-07-01" });
  });

  it("reads a custom period with an exclusive end day", () => {
    expect(
      parsePeriodParams(
        { period: "custom", from: "2026-01-01", to: "2026-03-01" },
        EVALUATED,
      ),
    ).toMatchObject({ startDay: "2026-01-01", endDay: "2026-03-01" });
  });

  it("refuses a custom period over 12 months as a 400", () => {
    expect(
      errorOf(() =>
        parsePeriodParams(
          { period: "custom", from: "2025-01-01", to: "2026-01-02" },
          EVALUATED,
        ),
      ),
    ).toMatchObject({ code: "period_too_long", statusCode: 400 });
  });

  it("refuses a year that isn't a whole number", () => {
    expect(
      errorOf(() =>
        parsePeriodParams({ period: "year", year: "2026.5" }, EVALUATED),
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
