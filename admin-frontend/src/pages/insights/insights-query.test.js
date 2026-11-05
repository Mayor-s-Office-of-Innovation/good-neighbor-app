import { test } from "vitest";
import assert from "node:assert/strict";
import {
  MAX_REPORT_SITES,
  customPeriodError,
  intervalOf,
  keptSelection,
  overviewApiParams,
  overviewSearch,
  periodApiParams,
  periodOf,
  periodSearch,
  samePeriod,
  readOverview,
  readPeriod,
  stepPeriod,
} from "./insights-query.js";

const october = {
  kind: "month",
  startDay: "2026-10-01",
  endDay: "2026-11-01",
  incomplete: false,
};

test("a page with no period asks for the server's current month", () => {
  assert.equal(readPeriod(""), null);
  assert.deepEqual(periodApiParams(null), {});
});

test("each period in the URL becomes the API's period", () => {
  assert.deepEqual(
    ["?period=2026-09", "?period=2025", "?period=fy2025"].map((s) =>
      periodApiParams(readPeriod(s)),
    ),
    [
      { period: "month", month: "2026-09" },
      { period: "year", year: "2025" },
      { period: "financialYear", startYear: "2025" },
    ],
  );
});

test("a custom period's last day is shown inclusive but sent exclusive", () => {
  const period = readPeriod("?period=custom&from=2026-09-01&to=2026-09-30");
  assert.deepEqual(periodApiParams(period), {
    period: "custom",
    from: "2026-09-01",
    to: "2026-10-01",
  });
});

test("a malformed period is dropped, so the page opens on the current month", () => {
  assert.deepEqual(
    [
      "?period=2026-13",
      "?period=fyX",
      "?period=custom&from=2026-09-01",
      "?period=custom&from=bad&to=2026-09-30",
      "?period=week",
      // The server refuses these, which would leave nothing to step from.
      "?period=custom&from=2026-02-01&to=2026-02-30",
      "?period=custom&from=2026-09-10&to=2026-09-01",
    ].map(readPeriod),
    [null, null, null, null, null, null, null],
  );
});

test("a period's own days stand in for the reply's until one arrives", () => {
  assert.deepEqual(
    [
      intervalOf({ kind: "month", month: "2026-12" }),
      intervalOf({ kind: "financialYear", startYear: 2025 }),
      intervalOf({ kind: "custom", from: "2026-03-05", to: "2026-03-09" }),
    ].map((i) => [i.startDay, i.endDay]),
    [
      ["2026-12-01", "2027-01-01"],
      ["2025-07-01", "2026-07-01"],
      ["2026-03-05", "2026-03-10"],
    ],
  );
});

test("a search longer than the server takes is dropped from a link", () => {
  assert.equal(readOverview(`?q=${"a".repeat(101)}`).q, "");
  assert.equal(readOverview(`?q=${"a".repeat(100)}`).q, "a".repeat(100));
});

test("the period a reply covers can be written back to the URL", () => {
  assert.equal(periodSearch(periodOf(october)).toString(), "period=2026-10");
  assert.equal(
    periodSearch(
      periodOf({ kind: "financialYear", startDay: "2025-07-01" }),
    ).toString(),
    "period=fy2025",
  );
  assert.equal(
    periodSearch(
      periodOf({
        kind: "custom",
        startDay: "2026-09-03",
        endDay: "2026-10-03",
      }),
    ).toString(),
    "period=custom&from=2026-09-03&to=2026-10-02",
  );
});

test("previous and next move by one period, across a year end", () => {
  const january = { kind: "month", month: "2026-01" };
  assert.deepEqual(stepPeriod(january, -1), {
    kind: "month",
    month: "2025-12",
  });
  assert.deepEqual(stepPeriod({ kind: "month", month: "2025-12" }, 1), {
    kind: "month",
    month: "2026-01",
  });
  assert.deepEqual(stepPeriod({ kind: "year", year: 2026 }, -1), {
    kind: "year",
    year: 2025,
  });
  assert.deepEqual(stepPeriod({ kind: "financialYear", startYear: 2025 }, 1), {
    kind: "financialYear",
    startYear: 2026,
  });
});

test("custom periods need an end on or after the start, and at most 12 months", () => {
  assert.deepEqual(
    [
      ["2026-09-10", "2026-09-01"],
      ["2025-09-01", "2026-09-01"],
      ["2025-09-01", "2026-08-31"],
      ["", "2026-08-31"],
      ["1999-12-01", "2000-01-15"],
    ].map(([from, to]) => customPeriodError(from, to)),
    [
      "admin.insights.period.endBeforeStart",
      "admin.insights.error.periodTooLong",
      "",
      "admin.insights.period.missingDay",
      "admin.insights.period.invalidDay",
    ],
  );
});

test("Overview opens on Top concerns, sorted by Site name", () => {
  assert.deepEqual(readOverview(""), {
    q: "",
    show: "top",
    managerId: "",
    providerId: "",
    department: "",
    responseState: "",
    publicContact: "",
    siteContact: "",
    sort: "name",
    cursor: "",
    selected: [],
  });
});

test("Overview ignores filter values it doesn't offer", () => {
  const state = readOverview(
    "?show=compliant&responseState=passed&publicContact=yes&sort=score",
  );
  assert.deepEqual(
    [state.show, state.responseState, state.publicContact, state.sort],
    ["top", "", "", "name"],
  );
});

test("Overview's URL leaves out defaults and keeps the period", () => {
  const state = {
    ...readOverview(""),
    q: "harbor",
    show: "all",
    responseState: "overdue",
    selected: ["s2", "s1"],
  };
  assert.equal(
    overviewSearch(state, { kind: "month", month: "2026-10" }),
    "?period=2026-10&q=harbor&show=all&responseState=overdue&selected=s2%2Cs1",
  );
  assert.equal(overviewSearch(readOverview(""), null), "");
});

test("Overview asks the API for the shown filters, never the selection", () => {
  const state = readOverview(
    "?q=pier&show=unknown&providerId=v1&siteContact=missing&sort=maxSeverity&cursor=50&selected=s1",
  );
  assert.deepEqual(
    overviewApiParams(state, { kind: "month", month: "2026-10" }),
    {
      period: "month",
      month: "2026-10",
      q: "pier",
      show: "unknown",
      providerId: "v1",
      siteContact: "missing",
      sort: "maxSeverity",
      cursor: "50",
    },
  );
});

test("the selection keeps only Sites on this page, up to the report limit", () => {
  const page = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
  assert.deepEqual(keptSelection(["s9", "gone", "s1"], page), ["s9", "s1"]);
  assert.equal(keptSelection(page, page).length, MAX_REPORT_SITES);
});

test("a period holding today is running, as of the time asked", () => {
  const now = new Date("2026-11-04T19:00:00.000Z");
  assert.deepEqual(
    [
      intervalOf({ kind: "month", month: "2026-11" }, now),
      intervalOf({ kind: "month", month: "2026-10" }, now),
    ].map((i) => [i.incomplete, i.observedTo]),
    [
      [true, "2026-11-04T19:00:00.000Z"],
      [false, undefined],
    ],
  );
});

test("two periods are the same when they name the same days", () => {
  assert.deepEqual(
    [
      samePeriod({ kind: "year", year: 2026 }, { year: 2026, kind: "year" }),
      samePeriod({ kind: "year", year: 2026 }, { kind: "year", year: 2025 }),
      samePeriod(null, null),
    ],
    [true, false, true],
  );
});
