import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import {
  issueRows,
  issuesByDay,
  issuesByWeek,
  issuesOfType,
  issuesToCsv,
  issueTypeKey,
  issueTypeTitle,
  lastReportedLabel,
  responseFor,
  summarizeIssues,
} from "./reports-issues.js";

describe("responseFor", () => {
  it("reads the response off stored fields, never labels", () => {
    expect(responseFor({ status: "open" }).kind).toBe("open");
    expect(responseFor({ status: "superseded" }).kind).toBe("open");
    expect(
      responseFor({ status: "completed", completionMethod: "311_filed" }).kind,
    ).toBe("sr311");
    expect(responseFor({ status: "in_progress", agency: "311" }).kind).toBe(
      "sr311",
    );
    expect(
      responseFor({
        status: "completed",
        kind: "non_actionable_escalation",
        buttons: ["Call SFPD: 415-553-0123"],
      }).kind,
    ).toBe("call");
    expect(
      responseFor({
        status: "completed",
        kind: "non_actionable_escalation",
        buttons: ["Call 911"],
      }).kind,
    ).toBe("emergencyCall");
    expect(
      responseFor({
        status: "completed",
        kind: "action",
        completionMethod: "site_team_resolved",
        latestUpdateLabel: "Resolved",
      }),
    ).toEqual({ kind: "onSite", label: "Resolved" });
    expect(
      responseFor({
        status: "cannot_do",
        cannotDo: { reason: "Not within the immediate area" },
      }),
    ).toEqual({
      kind: "cannotDo",
      label: t("reports.issues.response.cannotDoReason", {
        reason: "Not within the immediate area",
      }),
    });
  });
});

describe("summarizeIssues and issuesByDay", () => {
  const tasks = [
    {
      taskId: "a",
      category: "Litter",
      kind: "action",
      status: "completed",
      completionMethod: "manual",
      createdAt: "2026-09-27T16:00:00.000Z",
    },
    {
      taskId: "b",
      category: "Litter",
      kind: "action",
      status: "open",
      createdAt: "2026-09-28T05:30:00.000Z",
    }, // 22:30 PDT Sep 27
    {
      taskId: "c",
      category: "Graffiti",
      kind: "escalation",
      status: "completed",
      completionMethod: "311_filed",
      createdAt: "2026-09-29T16:00:00.000Z",
    },
    {
      taskId: "gone",
      category: "Graffiti",
      status: "superseded",
      createdAt: "2026-09-29T16:00:00.000Z",
    },
  ];

  it("counts by type and response, ignoring superseded tasks", () => {
    const summary = summarizeIssues(tasks);
    expect(summary.total).toBe(3);
    expect(summary.responded).toBe(2);
    expect(summary.byCategory).toEqual([
      {
        key: "Litter",
        category: "Litter",
        count: 2,
        lastReportedAt: "2026-09-28T05:30:00.000Z",
      },
      {
        key: "Graffiti",
        category: "Graffiti",
        count: 1,
        lastReportedAt: "2026-09-29T16:00:00.000Z",
      },
    ]);
    expect(summary.responses).toMatchObject({ onSite: 1, sr311: 1, open: 1 });
  });

  it("keys types by the raw category with label and 'other' fallbacks", () => {
    expect(issueTypeKey({ category: "Litter", userFriendlyLabel: "x" })).toBe(
      "Litter",
    );
    expect(issueTypeKey({ userFriendlyLabel: "Loose bag" })).toBe("Loose bag");
    expect(issueTypeKey({})).toBe("other");
    expect(issuesOfType(tasks, "Litter").map((task) => task.taskId)).toEqual([
      "b",
      "a",
    ]);
    expect(issuesOfType(tasks, "Graffiti").map((t) => t.taskId)).toEqual(["c"]);
    expect(issueTypeTitle(tasks, "Graffiti")).toBe("Graffiti");
    expect(issueTypeTitle([], "Needles")).toBe("Needles");
  });

  it("words 'last reported' relatively inside a week, as a date beyond it", () => {
    const now = new Date("2026-09-30T20:00:00.000Z");
    expect(lastReportedLabel("2026-09-30T16:00:00.000Z", now)).toBe(
      t("reports.issues.lastReported.today"),
    );
    expect(lastReportedLabel("2026-09-29T16:00:00.000Z", now)).toBe(
      t("reports.issues.lastReported.yesterday"),
    );
    expect(lastReportedLabel("2026-09-27T16:00:00.000Z", now)).toBe(
      t("reports.issues.lastReported.daysAgo", { count: 3 }),
    );
    expect(lastReportedLabel("2026-09-10T16:00:00.000Z", now)).toBe(
      t("reports.issues.lastReported.date", { date: "Sep 10" }),
    );
  });

  it("buckets by Pacific day", () => {
    expect(
      issuesByDay(tasks, ["2026-09-27", "2026-09-28", "2026-09-29"]),
    ).toEqual([
      { date: "2026-09-27", found: 2, responded: 1 },
      { date: "2026-09-28", found: 0, responded: 0 },
      { date: "2026-09-29", found: 1, responded: 1 },
    ]);
  });

  it("folds daily counts into Sunday-start weeks; the month's first week carries the label", () => {
    // Sep 27 (Sun) – Oct 7 (Wed): two weeks; Oct 1 (Thu) lands in week one.
    const days = [
      { date: "2026-09-27", found: 2, responded: 1 },
      { date: "2026-09-28", found: 0, responded: 0 },
      { date: "2026-10-01", found: 1, responded: 0 },
      { date: "2026-10-05", found: 3, responded: 2 },
      { date: "2026-10-07", found: 0, responded: 0 },
    ];
    expect(issuesByWeek(days)).toEqual([
      { start: "2026-09-27", found: 3, responded: 1, monthLabel: "Oct" },
      { start: "2026-10-04", found: 3, responded: 2 },
    ]);
  });

  it("lists newest first and exports CSV with quoting", () => {
    expect(issueRows(tasks).map((row) => row.taskId)).toEqual(["c", "b", "a"]);
    const csv = issuesToCsv([
      {
        taskId: "q",
        shortId: "X-1",
        category: "Litter",
        status: "cannot_do",
        cannotDo: { reason: 'Too much, "really"' },
        createdAt: "2026-09-27T16:00:00.000Z",
      },
    ]);
    expect(csv.split("\n")[0]).toBe("found,shortId,type,status,response");
    expect(csv).toContain('"Could not do: Too much, ""really"""');
  });
});
