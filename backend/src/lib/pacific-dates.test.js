import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonthsToFirst,
  dayKeysBetween,
  isDayKey,
  pacificDateKey,
  pacificDayStartIso,
  periodContaining,
  previousPeriod,
  weekdayIndex,
} from "./pacific-dates.js";

describe("pacificDateKey", () => {
  it("buckets a late-evening Pacific instant on its local day, not UTC", () => {
    // 23:30 PDT on Sep 29 is 06:30 UTC on Sep 30.
    expect(pacificDateKey("2026-09-30T06:30:00.000Z")).toBe("2026-09-29");
    expect(pacificDateKey("2026-09-30T07:00:00.000Z")).toBe("2026-09-30");
  });

  it("returns an empty key for garbage", () => {
    expect(pacificDateKey("not a date")).toBe("");
  });
});

describe("isDayKey", () => {
  it("accepts real dates only", () => {
    expect(isDayKey("2026-02-28")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-9-1")).toBe(false);
    expect(isDayKey(20260901)).toBe(false);
  });
});

describe("day arithmetic", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("steps months to the first of the month", () => {
    expect(addMonthsToFirst("2026-11-17", 2)).toBe("2027-01-01");
    expect(addMonthsToFirst("2026-01-17", -1)).toBe("2025-12-01");
  });

  it("lists the days of a half-open range", () => {
    expect(dayKeysBetween("2026-09-29", "2026-10-02")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    expect(dayKeysBetween("2026-09-29", "2026-09-29")).toEqual([]);
  });

  it("knows the weekday", () => {
    expect(weekdayIndex("2026-09-27")).toBe(0); // Sunday
    expect(weekdayIndex("2026-09-30")).toBe(3); // Wednesday
  });
});

describe("pacificDayStartIso", () => {
  it("is 07:00Z during daylight time and 08:00Z in standard time", () => {
    expect(pacificDayStartIso("2026-09-30")).toBe("2026-09-30T07:00:00.000Z");
    expect(pacificDayStartIso("2026-12-15")).toBe("2026-12-15T08:00:00.000Z");
  });

  it("is exact on the DST change days", () => {
    // Clocks spring forward on 2026-03-08 and fall back on 2026-11-01.
    expect(pacificDayStartIso("2026-03-08")).toBe("2026-03-08T08:00:00.000Z");
    expect(pacificDayStartIso("2026-03-09")).toBe("2026-03-09T07:00:00.000Z");
    expect(pacificDayStartIso("2026-11-01")).toBe("2026-11-01T07:00:00.000Z");
    expect(pacificDayStartIso("2026-11-02")).toBe("2026-11-02T08:00:00.000Z");
  });
});

describe("periods", () => {
  it("builds Sunday-to-Saturday weeks", () => {
    expect(periodContaining("week", "2026-09-30")).toEqual({
      kind: "week",
      start: "2026-09-27",
      endExclusive: "2026-10-04",
    });
    expect(periodContaining("week", "2026-09-27").start).toBe("2026-09-27");
  });

  it("builds calendar months and quarters", () => {
    expect(periodContaining("month", "2026-09-30")).toEqual({
      kind: "month",
      start: "2026-09-01",
      endExclusive: "2026-10-01",
    });
    expect(periodContaining("quarter", "2026-09-30")).toEqual({
      kind: "quarter",
      start: "2026-07-01",
      endExclusive: "2026-10-01",
    });
    expect(periodContaining("quarter", "2026-01-15").start).toBe("2026-01-01");
  });

  it("steps back one period of the same kind", () => {
    expect(previousPeriod(periodContaining("quarter", "2026-09-30"))).toEqual({
      kind: "quarter",
      start: "2026-04-01",
      endExclusive: "2026-07-01",
    });
    expect(previousPeriod(periodContaining("week", "2026-09-30"))).toEqual({
      kind: "week",
      start: "2026-09-20",
      endExclusive: "2026-09-27",
    });
    expect(previousPeriod(periodContaining("month", "2026-01-15"))).toEqual({
      kind: "month",
      start: "2025-12-01",
      endExclusive: "2026-01-01",
    });
  });
});
