import { describe, expect, it } from "vitest";

import {
  dayStatus,
  requiredOn,
  requirementFromCompliance,
  summarizeCheckDays,
} from "./check-compliance.js";

/**
 * @param {string} checkId
 * @param {string} startedAt
 * @param {Partial<Record<string, any>>} [extra]
 */
const completed = (checkId, startedAt, extra = {}) => ({
  checkId,
  status: "completed",
  startedAt,
  issueCount: 0,
  ...extra,
});

const THREE_A_DAY = { requiredPerDay: 3, required: true };

describe("requirementFromCompliance", () => {
  it("reads the site's cadence and period", () => {
    expect(
      requirementFromCompliance({
        requiredChecksPerDay: 3,
        perimeterChecksRequired: true,
        periodStart: "2026-07-01",
        periodEnd: "2026-12-31",
      }),
    ).toEqual({
      requiredPerDay: 3,
      required: true,
      assumed: false,
      periodStart: "2026-07-01",
      periodEnd: "2026-12-31",
    });
  });

  it("falls back to the city-wide 3 a day when no cadence is configured", () => {
    expect(requirementFromCompliance(undefined)).toMatchObject({
      requiredPerDay: 3,
      assumed: true,
    });
    expect(
      requirementFromCompliance({ requiredChecksPerDay: "lots" }),
    ).toMatchObject({ requiredPerDay: 3, assumed: true });
    expect(
      requirementFromCompliance({ requiredChecksPerDay: 2 }),
    ).toMatchObject({ requiredPerDay: 2, assumed: false });
    // An explicit "not required" still owes nothing.
    expect(
      requirementFromCompliance({ perimeterChecksRequired: false }).required,
    ).toBe(false);
  });
});

describe("requiredOn", () => {
  it("applies the cadence only inside the compliance period", () => {
    const req = {
      ...THREE_A_DAY,
      periodStart: "2026-09-10",
      periodEnd: "2026-09-20",
    };
    expect(requiredOn(req, "2026-09-09")).toBe(0);
    expect(requiredOn(req, "2026-09-10")).toBe(3);
    expect(requiredOn(req, "2026-09-20")).toBe(3);
    expect(requiredOn(req, "2026-09-21")).toBe(0);
    expect(requiredOn({ ...THREE_A_DAY, required: false }, "2026-09-15")).toBe(
      0,
    );
  });
});

describe("dayStatus", () => {
  const today = "2026-09-30";
  it("classifies past, present, and future days", () => {
    expect(dayStatus({ required: 3, completed: 3 }, "2026-09-29", today)).toBe(
      "complete",
    );
    expect(dayStatus({ required: 3, completed: 4 }, "2026-09-29", today)).toBe(
      "complete",
    );
    expect(dayStatus({ required: 3, completed: 1 }, "2026-09-29", today)).toBe(
      "partial",
    );
    expect(dayStatus({ required: 3, completed: 0 }, "2026-09-29", today)).toBe(
      "missed",
    );
    expect(dayStatus({ required: 3, completed: 1 }, today, today)).toBe(
      "pending",
    );
    expect(dayStatus({ required: 3, completed: 3 }, today, today)).toBe(
      "complete",
    );
    expect(dayStatus({ required: 3, completed: 0 }, "2026-10-01", today)).toBe(
      "upcoming",
    );
    expect(dayStatus({ required: 0, completed: 2 }, "2026-09-29", today)).toBe(
      "exempt",
    );
  });
});

describe("summarizeCheckDays", () => {
  const today = "2026-09-30";
  const dayKeys = [
    "2026-09-27",
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
  ];

  it("buckets completed perimeter checks by Pacific day and derives missed checks", () => {
    const checks = [
      // Sep 27: three checks, the last one late evening Pacific (UTC Sep 28).
      completed("a", "2026-09-27T15:00:00.000Z", { issueCount: 2 }),
      completed("b", "2026-09-27T21:00:00.000Z"),
      completed("c", "2026-09-28T05:30:00.000Z", { issueCount: 1 }),
      // Sep 28: one check plus an in-progress one that must not count.
      completed("d", "2026-09-28T16:00:00.000Z"),
      {
        checkId: "e",
        status: "in_progress",
        startedAt: "2026-09-28T20:00:00.000Z",
      },
      // Sep 29: nothing.
      // Sep 30 (today): one check and one single-issue report.
      completed("f", "2026-09-30T15:00:00.000Z"),
      completed("g", "2026-09-30T16:00:00.000Z", {
        flowType: "single-problem",
        issueCount: 1,
      }),
    ];

    const { days, totals } = summarizeCheckDays({
      checks,
      dayKeys,
      today,
      requirement: THREE_A_DAY,
    });

    expect(days.map((d) => [d.date, d.status, d.completed])).toEqual([
      ["2026-09-27", "complete", 3],
      ["2026-09-28", "partial", 1],
      ["2026-09-29", "missed", 0],
      ["2026-09-30", "pending", 1],
      ["2026-10-01", "upcoming", 0],
    ]);
    expect(days[0].checkIds).toEqual(["a", "b", "c"]);
    expect(days[0].issueCount).toBe(3);
    expect(days[3].reports).toBe(1);
    expect(days[3].checkIds).toEqual(["f", "g"]);
    expect(totals).toEqual({
      possible: 12, // four elapsed days × 3
      completed: 5, // 3 + 1 + 0 + 1
      recorded: 5,
      missed: 5, // past days only: 0 + 2 + 3
      issueCount: 4,
    });
  });

  it("caps a day's credit at the requirement but reports the raw count", () => {
    const { days, totals } = summarizeCheckDays({
      checks: [
        completed("a", "2026-09-29T15:00:00.000Z"),
        completed("b", "2026-09-29T17:00:00.000Z"),
        completed("c", "2026-09-29T19:00:00.000Z"),
        completed("d", "2026-09-29T21:00:00.000Z"),
      ],
      dayKeys: ["2026-09-29"],
      today,
      requirement: THREE_A_DAY,
    });
    expect(days[0].completed).toBe(4);
    expect(totals).toMatchObject({
      possible: 3,
      completed: 3,
      recorded: 4,
      missed: 0,
    });
  });

  it("owes nothing on exempt days", () => {
    const { days, totals } = summarizeCheckDays({
      checks: [completed("a", "2026-09-29T15:00:00.000Z")],
      dayKeys: ["2026-09-28", "2026-09-29"],
      today,
      requirement: { ...THREE_A_DAY, periodStart: "2026-09-29" },
    });
    expect(days[0]).toMatchObject({ status: "exempt", required: 0 });
    expect(days[1]).toMatchObject({ status: "partial", required: 3 });
    expect(totals).toMatchObject({ possible: 3, completed: 1, missed: 2 });
  });
});
