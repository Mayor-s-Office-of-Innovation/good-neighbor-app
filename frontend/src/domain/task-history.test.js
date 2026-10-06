import { describe, expect, it } from "vitest";
import {
  groupHistory,
  historyDuration,
  historyEnteredAt,
  historyDayLabel,
} from "./task-history.js";
import { t } from "../i18n/i18n.js";

const createdAt = "2026-10-01T12:00:00Z";
const taskAt = (minutes) => ({
  createdAt,
  completedAt: new Date(
    new Date(createdAt).getTime() + minutes * 60000,
  ).toISOString(),
});
describe("history day headings", () => {
  const now = new Date("2026-10-01T12:00:00-07:00");
  it.each([
    ["2026-10-01", "Today · Oct 1"],
    ["2026-09-30", "Yesterday · Sep 30"],
    ["2026-09-28", "Monday · Sep 28"],
    ["2026-09-27", "Sep 27"],
    ["2026-07-06", "Jul 6"],
  ])("labels %s relative to the current Pacific week", (date, label) => {
    expect(historyDayLabel(`${date}T12:00:00-07:00`, now)).toBe(label);
  });
});
describe("history duration", () => {
  it.each([
    [0, "lessThanMinute", undefined],
    [59, "minutes", 59],
    [60, "hours", 1],
    [1439, "hours", 23],
    [1440, "days", 1],
    [10079, "days", 6],
    [10080, "overWeek", undefined],
  ])(
    "formats %s minutes at the requested boundaries",
    (minutes, key, count) => {
      expect(historyDuration(taskAt(minutes))).toBe(
        t(`card.history.${key}`, count === undefined ? {} : { count }),
      );
    },
  );
  it("does not manufacture a duration for missing or invalid timestamps", () => {
    expect(historyDuration({ completedAt: createdAt })).toBe("");
    expect(historyDuration({ ...taskAt(1), createdAt: "bad" })).toBe("");
    expect(historyDuration(taskAt(-1))).toBe("");
  });
  it("uses terminal timestamps ahead of later updates", () => {
    expect(
      historyEnteredAt({ ...taskAt(60), updatedAt: "2026-10-06T12:00:00Z" }),
    ).toBe(taskAt(60).completedAt);
    expect(
      historyEnteredAt({
        cannotDo: { recordedAt: createdAt },
        updatedAt: "2026-10-06T12:00:00Z",
      }),
    ).toBe(createdAt);
  });
});
describe("history grouping", () => {
  const entries = [
    {
      task: {
        taskId: "a",
        category: "Litter",
        createdAt: "2026-10-01T06:59:00Z",
        completedAt: "2026-10-02T12:00:00Z",
      },
    },
    {
      task: {
        taskId: "b",
        category: "Litter",
        createdAt: "2026-10-01T07:01:00Z",
        completedAt: "2026-10-02T13:00:00Z",
      },
    },
    {
      task: {
        taskId: "c",
        category: "Graffiti",
        createdAt: "2026-10-01T07:01:00Z",
        completedAt: "2026-10-03T12:00:00Z",
      },
    },
  ];
  it("groups by Pacific resolution date, most recent first", () => {
    expect(
      groupHistory(entries).map((g) => g.entries.map((e) => e.task.taskId)),
    ).toEqual([["c"], ["b", "a"]]);
  });
  it("groups by Pacific opening day across midnight", () => {
    expect(groupHistory(entries, "opened").map((g) => g.key)).toEqual([
      "2026-10-01",
      "2026-09-30",
    ]);
  });
  it("groups by issue category, not action route", () => {
    expect(groupHistory(entries, "type").map((g) => g.key)).toEqual([
      "Graffiti",
      "Litter",
    ]);
  });
});
