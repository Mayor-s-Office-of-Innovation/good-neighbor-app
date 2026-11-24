import { describe, expect, it } from "vitest";
import { comparisonFor, resolvePeriod } from "./periods.js";

// A Wednesday noon in November, after the 2026-11-01 fall-back.
const EVALUATED = "2026-11-04T20:00:00.000Z";

describe("resolvePeriod", () => {
  it("bounds a month by Pacific midnights, ending at the fall-back day", () => {
    expect(
      resolvePeriod({ kind: "month", month: "2026-10" }, EVALUATED),
    ).toEqual({
      kind: "month",
      startDay: "2026-10-01",
      endDay: "2026-11-01",
      from: "2026-10-01T07:00:00.000Z",
      to: "2026-11-01T07:00:00.000Z",
      observedTo: "2026-11-01T07:00:00.000Z",
      timezone: "America/Los_Angeles",
      incomplete: false,
    });
  });

  it("gives the spring-forward month 743 hours", () => {
    const p = resolvePeriod({ kind: "month", month: "2026-03" }, EVALUATED);
    expect(p.from).toBe("2026-03-01T08:00:00.000Z");
    expect(p.to).toBe("2026-04-01T07:00:00.000Z");
    expect((Date.parse(p.to) - Date.parse(p.from)) / 3_600_000).toBe(743);
  });

  it("marks the current month incomplete and stops it at the evaluation time", () => {
    const p = resolvePeriod({ kind: "month", month: "2026-11" }, EVALUATED);
    expect(p).toMatchObject({
      from: "2026-11-01T07:00:00.000Z",
      to: "2026-12-01T08:00:00.000Z",
      observedTo: EVALUATED,
      incomplete: true,
    });
  });

  it("bounds a calendar year", () => {
    expect(
      resolvePeriod({ kind: "year", year: 2025 }, EVALUATED),
    ).toMatchObject({
      startDay: "2025-01-01",
      endDay: "2026-01-01",
      from: "2025-01-01T08:00:00.000Z",
    });
  });

  it("bounds a calendar quarter, Q3 being July to September", () => {
    expect(
      resolvePeriod({ kind: "quarter", year: 2026, quarter: 3 }, EVALUATED),
    ).toMatchObject({
      kind: "quarter",
      startDay: "2026-07-01",
      endDay: "2026-10-01",
      incomplete: false,
    });
    expect(
      resolvePeriod({ kind: "quarter", year: 2026, quarter: 4 }, EVALUATED),
    ).toMatchObject({ startDay: "2026-10-01", endDay: "2027-01-01" });
  });

  it("bounds a July–June financial year", () => {
    expect(
      resolvePeriod({ kind: "financialYear", startYear: 2025 }, EVALUATED),
    ).toMatchObject({
      startDay: "2025-07-01",
      endDay: "2026-07-01",
      from: "2025-07-01T07:00:00.000Z",
      to: "2026-07-01T07:00:00.000Z",
      incomplete: false,
    });
  });

  it("accepts a custom range of exactly 12 months", () => {
    expect(
      resolvePeriod(
        { kind: "custom", startDay: "2025-11-04", endDay: "2026-11-04" },
        EVALUATED,
      ),
    ).toMatchObject({ startDay: "2025-11-04", endDay: "2026-11-04" });
  });

  it.each([
    [
      { kind: "custom", startDay: "2025-11-04", endDay: "2026-11-05" },
      "period_too_long",
    ],
    [
      { kind: "custom", startDay: "2026-10-04", endDay: "2026-10-04" },
      "empty_period",
    ],
    [
      { kind: "custom", startDay: "2026-02-30", endDay: "2026-03-04" },
      "invalid_day",
    ],
    [{ kind: "month", month: "2026-13" }, "invalid_month"],
    [{ kind: "month", month: "1850-01" }, "invalid_month"],
    [
      { kind: "custom", startDay: "1900-01-01", endDay: "1900-02-01" },
      "invalid_day",
    ],
    [{ kind: "year", year: 2025.5 }, "invalid_year"],
    [{ kind: "week" }, "invalid_kind"],
    [{ kind: "quarter", year: 2026, quarter: 5 }, "invalid_quarter"],
    [{ kind: "quarter", year: 1999, quarter: 1 }, "invalid_year"],
    [{ kind: "quarter", year: 2027, quarter: 1 }, "future_period"],
    [{ kind: "month", month: "2026-12" }, "future_period"],
  ])("rejects %j with %s", (spec, code) => {
    // The API answers these as a bad request, not a server error.
    expect(() => resolvePeriod(/** @type {any} */ (spec), EVALUATED)).toThrow(
      expect.objectContaining({ code, statusCode: 400 }),
    );
  });

  it("refuses a snapshot time it can't read", () => {
    expect(() =>
      resolvePeriod({ kind: "month", month: "2026-11" }, "not a time"),
    ).toThrow("evaluatedAt");
  });
});

describe("comparisonFor", () => {
  it("judges a period cached earlier against the newer snapshot", () => {
    const october = resolvePeriod(
      { kind: "month", month: "2026-10" },
      "2026-10-15T20:00:00.000Z",
    );
    expect(comparisonFor(october, EVALUATED)).toMatchObject({
      basis: "complete_period",
      days: 31,
    });
  });

  it("compares complete months with the whole month before", () => {
    const current = resolvePeriod(
      { kind: "month", month: "2026-10" },
      EVALUATED,
    );
    const c = comparisonFor(current, EVALUATED);
    expect(c.basis).toBe("complete_period");
    expect(c.current).toEqual(current);
    expect(c.prior).toMatchObject({
      startDay: "2026-09-01",
      endDay: "2026-10-01",
      incomplete: false,
    });
  });

  it("aligns a partial month to the same count of complete days before", () => {
    const current = resolvePeriod(
      { kind: "month", month: "2026-11" },
      EVALUATED,
    );
    const c = comparisonFor(current, EVALUATED);
    expect(c.basis).toBe("elapsed_complete_days");
    expect([c.days, c.priorDays]).toEqual([3, 3]);
    expect(c.current).toMatchObject({
      startDay: "2026-11-01",
      endDay: "2026-11-04",
      to: "2026-11-04T08:00:00.000Z",
    });
    expect(c.prior).toMatchObject({
      startDay: "2026-10-01",
      endDay: "2026-10-04",
      from: "2026-10-01T07:00:00.000Z",
      to: "2026-10-04T07:00:00.000Z",
      clipped: false,
    });
  });

  it("clips the prior part at its own month end when it is shorter", () => {
    const evaluated = "2026-03-31T17:00:00.000Z";
    const current = resolvePeriod(
      { kind: "month", month: "2026-03" },
      evaluated,
    );
    const c = comparisonFor(current, evaluated);
    // Both sides cover 28 days, so a steady rate shows no change.
    expect([c.days, c.priorDays]).toEqual([28, 28]);
    expect(c.current).toMatchObject({
      startDay: "2026-03-01",
      endDay: "2026-03-29",
    });
    expect(c.prior).toMatchObject({
      startDay: "2026-02-01",
      endDay: "2026-03-01",
      clipped: true,
    });
  });

  it("says no comparison is possible on a period's first day", () => {
    const evaluated = "2026-11-01T15:00:00.000Z";
    const current = resolvePeriod(
      { kind: "month", month: "2026-11" },
      evaluated,
    );
    expect(comparisonFor(current, evaluated)).toEqual({
      basis: "not_enough_elapsed",
      days: 0,
      priorDays: 0,
      current,
      prior: null,
    });
  });

  it("compares a custom range with the same number of days just before it", () => {
    const current = resolvePeriod(
      { kind: "custom", startDay: "2026-10-10", endDay: "2026-10-20" },
      EVALUATED,
    );
    expect(comparisonFor(current, EVALUATED).prior).toMatchObject({
      startDay: "2026-09-30",
      endDay: "2026-10-10",
    });
  });

  it("compares a quarter with the quarter before", () => {
    const q1 = resolvePeriod(
      { kind: "quarter", year: 2026, quarter: 1 },
      EVALUATED,
    );
    expect(comparisonFor(q1, EVALUATED).prior).toMatchObject({
      kind: "quarter",
      startDay: "2025-10-01",
      endDay: "2026-01-01",
    });
  });

  it("compares a financial year with the one before", () => {
    const current = resolvePeriod(
      { kind: "financialYear", startYear: 2025 },
      EVALUATED,
    );
    expect(comparisonFor(current, EVALUATED).prior).toMatchObject({
      startDay: "2024-07-01",
      endDay: "2025-07-01",
    });
  });
});
