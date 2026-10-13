import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../lib/html.js";
import {
  calendarGrid,
  checksTab,
  dayDetail,
  issuesTab,
  periodFilters,
  recordsList,
  reportTabs,
  reportsShell,
  statusPill,
  weekChart,
} from "./reports-view.templates.js";

/**
 * @param {string} date
 * @param {string} status
 * @param {number} [completed]
 * @param {Record<string, any>} [extra]
 * @returns {any}
 */
const day = (date, status, completed = 0, extra = {}) => ({
  date,
  status,
  required: 3,
  completed,
  reports: 0,
  issueCount: 0,
  checkIds: [],
  ...extra,
});

/** @type {any} */
const period = {
  kind: "week",
  start: "2026-09-27",
  endExclusive: "2026-10-04",
};
const totals = {
  possible: 12,
  completed: 5,
  recorded: 5,
  missed: 5,
  issueCount: 3,
};
const previous = {
  ...period,
  start: "2026-09-20",
  endExclusive: "2026-09-27",
  totals: {
    possible: 21,
    completed: 3,
    recorded: 3,
    missed: 18,
    issueCount: 0,
  },
};
const days = [
  day("2026-09-27", "complete", 3, { issueCount: 2 }),
  day("2026-09-28", "partial", 1),
  day("2026-09-29", "missed"),
  day("2026-09-30", "pending", 1, { issueCount: 1 }),
  day("2026-10-01", "upcoming"),
  day("2026-10-02", "upcoming"),
  day("2026-10-03", "upcoming"),
];

describe("reportsShell", () => {
  it("renders the heading as the screen focus point with a site switcher", () => {
    const markup = reportsShell({
      heading: "Reports",
      body: "<p>x</p>",
      tab: "checks",
    });
    expect(markup).toContain("<site-switcher></site-switcher>");
    expect(markup).toContain("data-screen-focus");
    expect(markup).toContain("<p>x</p>");
    // A way back to the rest of the app, and the same gear menu as home.
    expect(markup).toContain('href="/today"');
    expect(markup).toContain(escapeHtml(t("reports.backHome")));
    expect(markup).toContain('id="home-settings"');
    expect(markup).toContain('id="language-dialog"');
    expect(markup).toContain('id="logout-dialog"');
    expect(markup).not.toContain('role="menu"');
    expect(
      reportsShell({
        heading: "Reports",
        body: "",
        tab: "checks",
        settingsMenuOpen: true,
      }),
    ).toContain('id="settings-logout"');
  });

  it("renders the Checks and Issues tabs, and no row for a single tab", () => {
    const tabs = reportTabs({ activeId: "issues" });
    expect(tabs).toContain('data-report-tab="checks"');
    expect(tabs).toContain('data-report-tab="issues"');
    expect(tabs).toContain(escapeHtml(t("reports.tab.issues")));
    expect(tabs.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(
      reportTabs({
        activeId: "checks",
        tabs: [{ id: "checks", labelKey: "reports.tab.checks" }],
      }),
    ).toBe("");
  });
});

describe("periodFilters", () => {
  it("offers the three period kinds and the given periods", () => {
    const markup = periodFilters({
      kind: "month",
      options: /** @type {any} */ ([
        { kind: "month", start: "2026-09-01", endExclusive: "2026-10-01" },
      ]),
      selectedStart: "2026-09-01",
    });
    expect(markup).toContain('id="reports-kind"');
    expect(markup).toContain('value="month"');
    expect(markup).toContain(escapeHtml(t("reports.kind.quarter")));
    expect(markup).toContain('<wa-option value="2026-09-01"');
    expect(markup).toContain("Sep 2026");
    expect(markup).toContain(escapeHtml(t("reports.filters.export")));
  });
});

describe("checksTab", () => {
  const report = { period, today: "2026-09-30", days, totals, previous };

  it("shows the headline, totals, calendar, legend, and records for a week", () => {
    const markup = checksTab({ report, filters: "", shown: 10 });
    expect(markup).toContain(
      escapeHtml(t("reports.checks.headline", { completed: 5, possible: 12 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.totals.completed", { count: 5 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.totals.missed", { count: 5 })),
    );
    // The week is still running: counts show elapsed days, not deltas.
    expect(
      markup.match(
        new RegExp(
          escapeHtml(t("reports.totals.inProgress", { elapsed: 4, total: 7 })),
          "g",
        ),
      ),
    ).toHaveLength(1);
    const finished = checksTab({
      report: { ...report, today: "2026-10-20" },
      filters: "",
      shown: 10,
    });
    expect(finished).toContain(
      escapeHtml(
        t("reports.delta.more", {
          count: 2,
          previous: t("reports.period.previous.week"),
        }),
      ),
    );
    expect(markup).toContain('class="reports-calendar"');
    expect(markup).not.toContain('class="reports-chart"');
    expect(markup).toContain(escapeHtml(t("reports.legend.missed")));
    // Newest record first; future days are not records.
    const first = markup.indexOf('data-day="2026-09-30"');
    const last = markup.indexOf('data-day="2026-09-27"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(last);
    expect(markup).not.toContain('data-day="2026-10-01"');
    expect(markup).toContain('href="/reports/checks/2026-09-30"');
    expect(markup).toContain(escapeHtml(t("reports.day.issues", { count: 1 })));
  });

  it("switches to the week chart for a quarter and says when nothing was owed", () => {
    const quarter = {
      ...report,
      period: /** @type {any} */ ({
        kind: "quarter",
        start: "2026-07-01",
        endExclusive: "2026-10-01",
      }),
    };
    const markup = checksTab({ report: quarter, filters: "", shown: 10 });
    expect(markup).toContain('class="reports-chart"');
    expect(markup).toContain('role="img"');
    const none = checksTab({
      report: { ...report, totals: { ...totals, possible: 0 } },
      filters: "",
      shown: 10,
    });
    expect(none).toContain(escapeHtml(t("reports.checks.noRequirement")));
  });
});

describe("weekChart", () => {
  it("draws one stacked bar per week with a hidden data table", () => {
    const markup = weekChart(days);
    expect(markup.match(/<rect/g)).toHaveLength(4); // 1 complete, 1 partial, 1 missed, 1 open
    expect(markup).toContain(
      'class="reports-chart__bar reports-chart__bar--missed"',
    );
    expect(markup).toContain('<table class="visually-hidden">');
    expect(markup).toContain(
      escapeHtml(t("reports.checks.week", { date: "Sep 27" })),
    );
  });
});

describe("calendarGrid", () => {
  it("labels every cell with its date, count, and status in text", () => {
    const markup = calendarGrid(days);
    expect(markup).toContain(
      escapeHtml(
        t("reports.checks.dayCell", {
          date: "Sep 29",
          completed: 0,
          required: 3,
          status: t("reports.status.missed"),
        }),
      ),
    );
    expect(markup).toContain("reports-calendar__day--complete");
    expect(markup).toContain(">3/3<");
    // Only days that were owed carry a count: the missed day shows 0/3, the
    // three upcoming days show nothing.
    expect(markup.match(/>0\/3</g)).toHaveLength(1);
  });
});

describe("recordsList", () => {
  it("pages with Show more", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      day(`2026-09-${String(i + 1).padStart(2, "0")}`, "complete", 3),
    );
    const markup = recordsList({
      days: many,
      today: "2026-09-30",
      period: /** @type {any} */ ({
        kind: "month",
        start: "2026-09-01",
        endExclusive: "2026-10-01",
      }),
      shown: 10,
    });
    expect(markup.match(/data-day=/g)).toHaveLength(10);
    expect(markup).toContain('id="reports-show-more"');
    expect(markup).toContain('data-next="20"');
    const all = recordsList({
      days: many,
      today: "2026-09-30",
      period: /** @type {any} */ ({
        kind: "month",
        start: "2026-09-01",
        endExclusive: "2026-10-01",
      }),
      shown: 20,
    });
    expect(all).not.toContain('id="reports-show-more"');
  });

  it("says when nothing was due", () => {
    const markup = recordsList({
      days: [day("2026-10-01", "upcoming")],
      today: "2026-09-30",
      period,
      shown: 10,
    });
    expect(markup).toContain(escapeHtml(t("reports.records.empty")));
  });
});

describe("statusPill", () => {
  it("pairs the color class with the word", () => {
    expect(statusPill("partial")).toContain("reports-pill--partial");
    expect(statusPill("partial")).toContain(
      escapeHtml(t("reports.status.partial")),
    );
  });
});

describe("dayDetail", () => {
  it("lists each completed check and a missing entry per check still owed", () => {
    const markup = dayDetail({
      day: day("2026-09-29", "partial", 2, { issueCount: 4 }),
      today: "2026-09-30",
      checks: [
        {
          check: {
            checkId: "a",
            completedAt: "2026-09-29T16:04:00.000Z",
            issueCount: 2,
          },
          evidence: [
            { artifactId: "p1", kind: "photo", url: "https://media/p1" },
            { artifactId: "p2", kind: "photo", url: "" },
          ],
          tasks: [
            {
              taskId: "t1",
              category: "Litter",
              status: "completed",
              shortId: "GUB-STJ-001",
            },
          ],
        },
        {
          check: {
            checkId: "b",
            completedAt: "2026-09-29T21:07:00.000Z",
            issueCount: 0,
          },
          evidence: [{ artifactId: "d1", kind: "text" }],
          tasks: [],
        },
      ],
    });
    expect(markup).toContain('href="/reports"');
    expect(markup).toContain(
      escapeHtml(
        t("reports.day.requiredCompletedOf", { completed: 2, required: 3 }),
      ),
    );
    expect(markup.match(/reports-timeline__item--done/g)).toHaveLength(2);
    expect(markup.match(/reports-timeline__item--missed/g)).toHaveLength(1);
    expect(markup).toContain(escapeHtml(t("reports.check.missing")));
    expect(markup).toContain("9:04 AM");
    expect(markup).toContain('data-full-src="https://media/p1"');
    expect(markup).toContain("reports-timeline__photo--placeholder");
    expect(markup).toContain(escapeHtml(t("reports.check.description")));
    expect(markup).toContain(escapeHtml(t("reports.task.status.completed")));
    expect(markup).toContain("GUB-STJ-001");
  });

  it("calls a missing check on today 'still due' rather than missed", () => {
    const markup = dayDetail({
      day: day("2026-09-30", "pending", 0),
      today: "2026-09-30",
      checks: [],
    });
    expect(markup.match(/reports-timeline__item--due/g)).toHaveLength(3);
    expect(markup).toContain(escapeHtml(t("reports.check.due")));
    expect(markup).not.toContain(escapeHtml(t("reports.check.missing")));
  });
});

describe("issuesTab", () => {
  const tasks = [
    {
      taskId: "t1",
      shortId: "GUB-STJ-001",
      category: "Litter",
      kind: "action",
      status: "completed",
      completionMethod: "site_team_resolved",
      latestUpdateLabel: "Resolved",
      createdAt: "2026-09-27T16:00:00.000Z",
    },
    {
      taskId: "t2",
      shortId: "GUB-STJ-002",
      category: "Litter",
      kind: "escalation",
      status: "in_progress",
      completionMethod: "311_filed",
      agency: "311",
      createdAt: "2026-09-28T16:00:00.000Z",
    },
    {
      taskId: "t3",
      category: "Needles",
      kind: "non_actionable_escalation",
      status: "completed",
      buttons: ["Call 911"],
      createdAt: "2026-09-29T16:00:00.000Z",
    },
    {
      taskId: "t4",
      category: "Graffiti",
      kind: "action",
      status: "open",
      createdAt: "2026-09-30T16:00:00.000Z",
    },
    {
      taskId: "old",
      category: "Graffiti",
      status: "superseded",
      createdAt: "2026-09-30T16:00:00.000Z",
    },
  ];
  const report = {
    period,
    today: "2026-09-30",
    tasks,
    previous: { ...period, count: 2 },
  };

  it("counts issues and their responses, and lists them newest first", () => {
    const markup = issuesTab({ report, filters: "", shown: 10 });
    expect(markup).toContain(
      escapeHtml(t("reports.issues.headline", { count: 4 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.issues.respondedLine", { count: 3 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.issues.byType.count", { count: 2 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.issues.responses.sr311", { count: 1 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.issues.responses.emergencyCall", { count: 1 })),
    );
    expect(markup).toContain(
      escapeHtml(t("reports.issues.responses.open", { count: 1 })),
    );
    const first = markup.indexOf('data-task-id="t4"');
    const last = markup.indexOf('data-task-id="t1"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(last);
    expect(markup).not.toContain('data-task-id="old"');
    expect(markup).toContain("reports-pill--sr311");
    expect(markup).toContain(escapeHtml(t("reports.issues.kind.sr311")));
    expect(markup).toContain(
      escapeHtml(
        t("reports.issues.response.label", {
          response: t("reports.issues.response.open"),
        }),
      ),
    );
    expect(markup).toContain('class="reports-chart"');
    // The week is still running, so no count delta against last week.
    expect(markup).not.toContain(escapeHtml(t("reports.period.previous.week")));
  });

  it("says when nothing was found", () => {
    const markup = issuesTab({
      report: { ...report, tasks: [] },
      filters: "",
      shown: 10,
    });
    expect(markup).toContain(escapeHtml(t("reports.issues.none")));
  });
});

describe("a site without a configured cadence", () => {
  const exemptDays = [
    day("2026-09-26", "exempt", 0, { required: 0, reports: 1 }),
    day("2026-09-27", "exempt", 2, { required: 0, issueCount: 1 }),
    day("2026-09-28", "exempt", 0, { required: 0 }),
    day("2026-09-29", "exempt", 1, { required: 0 }),
  ];
  const report = {
    period,
    today: "2026-09-30",
    days: exemptDays,
    totals: {
      possible: 0,
      completed: 0,
      recorded: 3,
      missed: 0,
      issueCount: 1,
    },
    previous: { ...previous, totals: { ...previous.totals, possible: 0 } },
  };

  it("still shows its checks instead of an empty report", () => {
    const markup = checksTab({ report, filters: "", shown: 10 });
    expect(markup).toContain(
      escapeHtml(t("reports.totals.completed", { count: 3 })),
    );
    expect(markup).toContain(escapeHtml(t("reports.checks.noRequirement")));
    expect(markup).toContain('data-day="2026-09-29"');
    expect(markup).toContain('data-day="2026-09-27"');
    expect(markup).not.toContain('data-day="2026-09-28"');
    // A day with only a single-issue report is still a record with a link.
    expect(markup).toContain('data-day="2026-09-26"');
    expect(markup).toContain(
      escapeHtml(t("reports.day.reportsOnly", { count: 1 })),
    );
    expect(markup).toContain(escapeHtml(t("reports.status.exempt")));
    expect(markup).toContain(
      escapeHtml(t("reports.totals.completed", { count: 2 })),
    );
    expect(markup).not.toContain(escapeHtml(t("reports.records.empty")));
    expect(markup).toContain(escapeHtml(t("reports.legend.recorded")));
    const quarter = checksTab({
      report: {
        ...report,
        period: {
          kind: "quarter",
          start: "2026-07-01",
          endExclusive: "2026-10-01",
        },
      },
      filters: "",
      shown: 10,
    });
    expect(quarter).toContain("reports-chart__bar--recorded");
    // Axis labels are HTML text under the chart, never SVG <text>.
    expect(quarter).toContain('class="reports-chart__tick"');
    expect(quarter).not.toContain("<text");
  });

  it("says when the standard cadence is standing in for a missing one", () => {
    const withNote = checksTab({
      report: {
        period,
        today: "2026-09-30",
        days,
        totals,
        previous,
        requirement: { requiredPerDay: 3, required: true, assumed: true },
      },
      filters: "",
      shown: 10,
    });
    expect(withNote).toContain(escapeHtml(t("reports.checks.assumedCadence")));
    const configured = checksTab({
      report: { period, today: "2026-09-30", days, totals, previous },
      filters: "",
      shown: 10,
    });
    expect(configured).not.toContain(
      escapeHtml(t("reports.checks.assumedCadence")),
    );
  });
});
