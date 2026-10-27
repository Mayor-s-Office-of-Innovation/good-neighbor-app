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

describe("resolvedInPeriod", () => {
  /** @type {import("./reports-periods.js").Period} */
  const period = {
    kind: "month",
    start: "2026-10-01",
    endExclusive: "2026-11-01",
  };
  it("requires user completion and both timestamps within Pacific period boundaries", async () => {
    const { resolvedInPeriod } = await import("./reports-issues.js");
    const task = {
      taskId: "t",
      status: "completed",
      createdAt: "2026-10-01T07:00:00Z",
      completedAt: "2026-11-01T06:59:59Z",
    };
    expect(resolvedInPeriod(task, period)).toBe(true);
    expect(
      resolvedInPeriod(
        { ...task, completedAt: "2026-11-01T07:00:00Z" },
        period,
      ),
    ).toBe(false);
    expect(
      resolvedInPeriod({ ...task, createdAt: "2026-10-01T06:59:59Z" }, period),
    ).toBe(false);
    expect(
      resolvedInPeriod(
        { ...task, status: "in_progress", completionMethod: "311_filed" },
        period,
      ),
    ).toBe(false);
    expect(resolvedInPeriod({ ...task, status: "cannot_do" }, period)).toBe(
      false,
    );
    expect(resolvedInPeriod({ ...task, completedAt: undefined }, period)).toBe(
      false,
    );
  });
});

describe("issue reporting metrics", () => {
  const period = {
    kind: /** @type {const} */ ("month"),
    start: "2026-09-01",
    endExclusive: "2026-10-01",
  };
  const report = {
    period,
    today: "2026-10-26",
    asOf: "2026-10-01T06:59:59.999Z",
    updates: [],
  };
  const issue = {
    taskId: "a",
    createdAt: "2026-09-20T16:00:00Z",
    status: "open",
  };

  it("splits all reports into disjoint resolved and unresolved groups and uses the median", async () => {
    const { resolutionSummary } = await import("./reports-issues.js");
    const tasks = [1, 2, 10, 20].map((hours) => ({
      ...issue,
      status: "completed",
      completedAt: new Date(
        Date.parse(issue.createdAt) + hours * 3600000,
      ).toISOString(),
    }));
    tasks.push({
      ...issue,
      status: "completed",
      completedAt: "2026-10-02T12:00:00Z",
    });
    expect(resolutionSummary(tasks, period)).toEqual({
      resolved: 4,
      unresolved: 1,
      median: 6 * 3600000,
    });
    expect(resolutionSummary([issue], period).median).toBe(null);
    const chart = issuesByDay(tasks, ["2026-09-20"], period);
    expect(chart[0]).toMatchObject({ found: 5, responded: 4 });
  });

  it("does not count notes/photos as actions and assesses age at the historical cutoff", async () => {
    const { attentionFlags } = await import("./reports-issues.js");
    const updates = [
      {
        taskId: "a",
        type: "note_photo_update",
        occurredAt: "2026-09-25T12:00:00Z",
      },
    ];
    expect(attentionFlags(issue, { ...report, updates })).toMatchObject({
      noAction: true,
      aged: true,
    });
    expect(
      attentionFlags({ ...issue, inProgressAt: "2026-10-02T12:00:00Z" }, report)
        .noAction,
    ).toBe(true);
    expect(
      attentionFlags({ ...issue, inProgressAt: "2026-09-25T12:00:00Z" }, report)
        .noAction,
    ).toBe(false);
    expect(
      attentionFlags({ ...issue, createdAt: "2026-09-30T12:00:00Z" }, report)
        .aged,
    ).toBe(false);
  });

  it("counts open City tickets despite updates, and uses dated closures for historical periods", async () => {
    const { attentionFlags } = await import("./reports-issues.js");
    const task = {
      ...issue,
      appActionResults: [
        { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
      ],
      report311: {
        status: "Open",
        submittedAt: issue.createdAt,
        events: [
          {
            kind: "statusChanged",
            value: "In progress",
            occurredAt: "2026-09-25T12:00:00Z",
          },
        ],
      },
    };
    expect(attentionFlags(task, report).awaiting).toBe(true);
    task.report311.status = "Closed";
    task.report311.events = [
      { kind: "resolved", value: "", occurredAt: "2026-10-02T12:00:00Z" },
    ];
    expect(attentionFlags(task, report).awaiting).toBe(true);
    task.report311.events[0].occurredAt = "2026-09-25T12:00:00Z";
    expect(attentionFlags(task, report).awaiting).toBe(false);
    expect(
      attentionFlags({ ...task, report311: undefined }, report).awaiting,
    ).toBe(false);
  });

  it("formats zero denominators, increases, decreases, and equal counts", async () => {
    const { issueTrend } = await import("./reports-issues.js");
    const previous = t("reports.period.previous.month");
    expect(issueTrend(12, 8, "month")).toBe(
      t("reports.issues.trend.more", { percent: 50, previous }),
    );
    expect(issueTrend(0, 8, "month")).toBe(
      t("reports.issues.trend.less", { percent: 100, previous }),
    );
    expect(issueTrend(8, 8, "month")).toBe(
      t("reports.delta.sameCount", { previous }),
    );
    expect(issueTrend(8, 0, "month")).toBe(
      t("reports.issues.trend.none", { previous }),
    );
  });
});
