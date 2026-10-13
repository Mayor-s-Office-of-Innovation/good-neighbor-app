import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import {
  calendarCells,
  completionPercent,
  countDeltaLine,
  dayTitle,
  daysToCsv,
  periodContaining,
  periodLabel,
  periodOptions,
  previousPeriod,
  rateDeltaLine,
  recordDays,
  weekBuckets,
  weekdayInitials,
} from "./reports-periods.js";

/**
 * @param {string} date
 * @param {string} status
 * @param {number} [completed]
 * @param {number} [required]
 * @returns {any}
 */
const day = (date, status, completed = 0, required = 3) => ({
  date,
  status,
  required,
  completed,
  reports: 0,
  issueCount: 0,
  checkIds: [],
});

describe("periods", () => {
  it("matches the backend's Sunday weeks, months, and quarters", () => {
    expect(periodContaining("week", "2026-09-30")).toEqual({
      kind: "week",
      start: "2026-09-27",
      endExclusive: "2026-10-04",
    });
    expect(periodContaining("month", "2026-09-30").start).toBe("2026-09-01");
    expect(periodContaining("quarter", "2026-09-30")).toEqual({
      kind: "quarter",
      start: "2026-07-01",
      endExclusive: "2026-10-01",
    });
    expect(
      previousPeriod(periodContaining("quarter", "2026-01-15")).start,
    ).toBe("2025-10-01");
  });

  it("labels periods for the picker", () => {
    expect(periodLabel(periodContaining("quarter", "2026-09-30"))).toBe(
      t("reports.period.quarter", { quarter: 3, year: 2026 }),
    );
    expect(periodLabel(periodContaining("month", "2026-09-30"))).toBe(
      "Sep 2026",
    );
    expect(periodLabel(periodContaining("week", "2026-09-23"))).toBe(
      t("reports.period.weekSameMonth", { first: "Sep 20", last: "26" }),
    );
    expect(periodLabel(periodContaining("week", "2026-09-30"))).toBe(
      t("reports.period.weekSpan", { first: "Sep 27", last: "Oct 3" }),
    );
  });

  it("offers the current period first, then earlier ones", () => {
    const options = periodOptions("month", "2026-09-30", 3);
    expect(options.map((p) => p.start)).toEqual([
      "2026-09-01",
      "2026-08-01",
      "2026-07-01",
    ]);
  });
});

describe("deltas", () => {
  it("compares completion rates in whole percentage points", () => {
    expect(completionPercent({ possible: 276, completed: 248 })).toBe(90);
    expect(completionPercent({ possible: 0, completed: 0 })).toBeNull();
    expect(
      rateDeltaLine(
        { possible: 276, completed: 248 },
        { possible: 273, completed: 237 },
        "quarter",
      ),
    ).toBe(
      t("reports.delta.higher", {
        count: 3,
        previous: t("reports.period.previous.quarter"),
      }),
    );
    expect(
      rateDeltaLine(
        { possible: 10, completed: 9 },
        { possible: 0, completed: 0 },
        "week",
      ),
    ).toBe(t("reports.delta.noPrevious"));
  });

  it("describes count changes with the right pluralization", () => {
    const previous = t("reports.period.previous.month");
    expect(countDeltaLine(87, 83, "month")).toBe(
      t("reports.delta.more", { count: 4, previous }),
    );
    expect(countDeltaLine(3, 4, "month")).toBe(
      t("reports.delta.fewer", { count: 1, previous }),
    );
    expect(countDeltaLine(3, 3, "month")).toBe(
      t("reports.delta.sameCount", { previous }),
    );
  });
});

describe("records and titles", () => {
  it("lists only days that were owed and have started, newest first", () => {
    const days = [
      day("2026-09-27", "complete", 3),
      day("2026-09-28", "exempt", 0, 0),
      day("2026-09-29", "missed"),
      day("2026-09-30", "pending", 1),
      day("2026-10-01", "upcoming"),
    ];
    expect(recordDays(days).map((d) => d.date)).toEqual([
      "2026-09-30",
      "2026-09-29",
      "2026-09-27",
    ]);
    // Checks recorded on a day with no requirement still count as records.
    expect(
      recordDays([day("2026-09-26", "exempt", 2, 0)]).map((d) => d.date),
    ).toEqual(["2026-09-26"]);
  });

  it("names days relative to today", () => {
    expect(dayTitle("2026-09-30", "2026-09-30")).toBe(
      t("reports.day.today", { date: "Sep 30" }),
    );
    expect(dayTitle("2026-09-29", "2026-09-30")).toBe(
      t("reports.day.yesterday", { date: "Sep 29" }),
    );
    expect(dayTitle("2026-09-28", "2026-09-30")).toBe(
      t("reports.day.weekday", { weekday: "Monday", date: "Sep 28" }),
    );
  });
});

describe("chart and calendar buckets", () => {
  it("groups days into Sunday weeks and marks the first of each month", () => {
    const days = [
      day("2026-09-27", "complete", 3),
      day("2026-09-28", "partial", 1),
      day("2026-09-29", "missed"),
      day("2026-09-30", "pending", 1),
      day("2026-10-01", "upcoming"),
      day("2026-10-04", "upcoming"),
    ];
    const weeks = weekBuckets(days);
    expect(weeks).toEqual([
      {
        start: "2026-09-27",
        complete: 1,
        partial: 1,
        missed: 1,
        open: 2,
        monthLabel: "Oct",
      },
      { start: "2026-10-04", complete: 0, partial: 0, missed: 0, open: 1 },
    ]);
  });

  it("pads the calendar so the first day sits under its weekday", () => {
    const cells = calendarCells([day("2026-09-01", "complete", 3)]);
    // 2026-09-01 is a Tuesday: two blanks (Sun, Mon) first.
    expect(cells.slice(0, 2)).toEqual([null, null]);
    expect(cells[2]?.date).toBe("2026-09-01");
    expect(calendarCells([])).toEqual([]);
  });

  it("gives Sunday-first weekday initials", () => {
    expect(weekdayInitials()).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
  });
});

describe("daysToCsv", () => {
  it("writes one row per day with a header", () => {
    expect(
      daysToCsv([
        { ...day("2026-09-29", "partial", 2), reports: 1, issueCount: 4 },
      ]),
    ).toBe(
      "date,status,required,completed,reports,issues\n2026-09-29,partial,3,2,1,4\n",
    );
  });
});
