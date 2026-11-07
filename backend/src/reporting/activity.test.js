import { describe, expect, it } from "vitest";
import { SITE_DAY_METRICS, compareTotals, sumSiteDays } from "./activity.js";

describe("sumSiteDays and compareTotals", () => {
  /**
   * @param {string} siteId
   * @param {string} day
   */
  const day = (siteId, day) => ({
    siteId,
    day,
    ...Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0])),
    completedPerimeterChecks: 1,
  });
  const rows = [
    day("s1", "2026-10-02"),
    day("s1", "2026-11-02"),
    day("s2", "2026-11-02"),
  ];

  it("leaves out the end day", () => {
    const { total, bySite } = sumSiteDays(rows, {
      startDay: "2026-11-01",
      endDay: "2026-11-02",
    });
    expect(total.completedPerimeterChecks).toBe(0);
    expect(bySite.size).toBe(0);
  });

  it("includes the start day, per Site and overall", () => {
    const { total, bySite } = sumSiteDays(rows, {
      startDay: "2026-11-02",
      endDay: "2026-11-03",
    });
    expect(total.completedPerimeterChecks).toBe(2);
    expect(
      [...bySite].map(([site, t]) => [site, t.completedPerimeterChecks]),
    ).toEqual([
      ["s1", 1],
      ["s2", 1],
    ]);
  });

  it("limits totals to the chosen Sites", () => {
    const { total } = sumSiteDays(
      rows,
      { startDay: "2026-10-01", endDay: "2026-12-01" },
      new Set(["s2"]),
    );
    expect(total.completedPerimeterChecks).toBe(1);
  });

  it("reports a drop as a negative change", () => {
    const november = sumSiteDays(rows, {
      startDay: "2026-11-01",
      endDay: "2026-12-01",
    }).total;
    const october = sumSiteDays(rows, {
      startDay: "2026-10-01",
      endDay: "2026-11-01",
    }).total;
    expect(compareTotals(october, november).completedPerimeterChecks).toEqual({
      current: 1,
      prior: 2,
      change: -1,
    });
  });

  it("reports the change in counts, including from zero", () => {
    const current = sumSiteDays(rows, {
      startDay: "2026-11-01",
      endDay: "2026-12-01",
    }).total;
    const prior = sumSiteDays(rows, {
      startDay: "2026-09-01",
      endDay: "2026-10-01",
    }).total;
    expect(compareTotals(current, prior).completedPerimeterChecks).toEqual({
      current: 2,
      prior: 0,
      change: 2,
    });
  });
});
