import { test } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { formatDateTime } from "../../../../frontend/src/i18n/dates.js";
import { escapeHtml } from "../../dom.js";
import { weekdayInitials } from "../../../../frontend/src/domain/reports-periods.js";
import { activityChart, buckets, chartUnit } from "./activity-chart.js";

/** @param {string} html @param {string} attribute */
const values = (html, attribute) =>
  [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map(
    (m) => m[1],
  );
/** @param {string} html */
const barLabels = (html) => {
  const box = document.createElement("div");
  box.innerHTML = html;
  // A label's lines joined by a space, as a reader sees "Jan" over "2026".
  return [...box.querySelectorAll("[data-bar-label]")].map((label) =>
    [...label.childNodes].map((n) => n.textContent).join(" "),
  );
};
/** @param {string} day @param {Intl.DateTimeFormatOptions} options */
const pacificDay = (day, options) =>
  // 3 PM Pacific, inside the day in any season.
  formatDateTime(`${day}T23:00:00Z`, options);

/** @param {string} from @param {number} count @param {(i: number) => number | null} value */
const run = (from, count, value) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { day: d.toISOString().slice(0, 10), value: value(i) };
  });

test("a month or less is drawn by day, up to 100 days by week, longer by month", () => {
  assert.deepEqual(
    [
      { startDay: "2026-10-01", endDay: "2026-11-01" },
      { startDay: "2026-07-01", endDay: "2026-10-01" },
      { startDay: "2025-07-01", endDay: "2026-07-01" },
    ].map(chartUnit),
    ["day", "week", "month"],
  );
});

test("weeks start on Sunday, as the app's reports do, and the first is clipped to the period", () => {
  // Jul 1, 2026 is a Wednesday, so its week runs Jul 1–4.
  const span = { startDay: "2026-07-01", endDay: "2026-07-20" };
  const list = buckets(
    span,
    run("2026-07-01", 19, () => 1),
    "week",
  );
  assert.deepEqual(
    list.map((b) => [b.start, b.value, b.partial]),
    [
      ["2026-07-01", 4, true],
      ["2026-07-05", 7, false],
      ["2026-07-12", 7, false],
      ["2026-07-19", 1, true],
    ],
  );
});

test("a day calendar puts Sunday in its first column", () => {
  const box = document.createElement("div");
  box.innerHTML = activityChart(
    { startDay: "2026-10-01", endDay: "2026-11-01" },
    run("2026-10-01", 31, () => 1),
    "checks",
  );
  const [heads, firstWeek] = box.querySelectorAll("tr");
  assert.deepEqual(
    [...heads.cells].map((c) => c.textContent),
    weekdayInitials(),
  );
  // Oct 1, 2026 is a Thursday.
  assert.deepEqual(
    [...firstWeek.cells].map((c) => c.querySelector("span")?.textContent ?? ""),
    ["", "", "", "", "1", "2", "3"],
  );
});

test("a running period's last day is drawn as partial and doesn't set the shading", () => {
  const span = {
    startDay: "2026-11-01",
    endDay: "2026-12-01",
    incomplete: true,
    observedTo: "2026-11-04T19:00:00.000Z",
  };
  const box = document.createElement("div");
  box.innerHTML = activityChart(
    span,
    run("2026-11-01", 4, (i) => (i === 3 ? 9 : 1)),
    "checks",
  );
  const cells = [...box.querySelectorAll("td[data-cal]")].slice(0, 4);
  assert.deepEqual(
    cells.map((c) => [
      c.getAttribute("data-cal-level"),
      c.hasAttribute("data-cal-partial"),
    ]),
    [
      ["3", false],
      ["3", false],
      ["3", false],
      ["3", true],
    ],
  );
  assert.equal(
    cells[3].getAttribute("title"),
    t("admin.insights.chart.partialDay"),
  );
});

test("a running period's week is partial even when its last day is today", () => {
  // Nov 7, 2026 is a Saturday, the last day of its week.
  const span = {
    startDay: "2026-10-01",
    endDay: "2027-01-01",
    incomplete: true,
    observedTo: "2026-11-07T19:00:00.000Z",
  };
  const list = buckets(
    span,
    run("2026-10-01", 38, () => 1),
    "week",
  );
  assert.deepEqual(
    list.slice(5, 7).map((b) => [b.start, b.partial, b.future]),
    [
      ["2026-11-01", true, false],
      ["2026-11-08", false, true],
    ],
  );
});

test("a month with no data is no data, not zero; a half-covered one is partial", () => {
  const span = { startDay: "2026-01-01", endDay: "2026-04-01" };
  // Data begins Feb 15.
  const list = buckets(
    span,
    run("2026-02-15", 45, () => 2),
    "month",
  );
  assert.deepEqual(
    list.map((b) => [b.value, b.partial]),
    [
      [null, false],
      [28, true],
      [62, false],
    ],
  );
});

test("a day calendar leaves days before the data hatched, with no count", () => {
  const span = { startDay: "2026-10-01", endDay: "2026-11-01" };
  const html = activityChart(
    span,
    run("2026-10-10", 22, (i) => i % 4),
    "checks",
  );
  assert.equal(html.match(/data-cal="none"/g)?.length, 9);
  assert.ok(html.includes('aria-hidden="true"'));
});

test("a period with no data at all says so instead of drawing", () => {
  const span = { startDay: "2025-01-01", endDay: "2025-02-01" };
  assert.ok(
    activityChart(span, [], "issues").includes(
      t("admin.insights.chart.noData"),
    ),
  );
});

test("weekly bars name each month once", () => {
  const span = { startDay: "2026-07-01", endDay: "2026-09-01" };
  const html = activityChart(
    span,
    run("2026-07-01", 62, () => 1),
    "issues",
  );
  assert.deepEqual(
    barLabels(html).filter(Boolean),
    ["2026-07-01", "2026-08-01"].map((day) =>
      pacificDay(day, { month: "short" }),
    ),
  );
});

test("days after the data time in a running month are left blank, not marked no data", () => {
  const span = {
    startDay: "2026-11-01",
    endDay: "2026-12-01",
    incomplete: true,
    observedTo: "2026-11-04T19:00:00.000Z",
  };
  const html = activityChart(
    span,
    run("2026-11-01", 4, () => 2),
    "checks",
  );
  assert.equal(values(html, "data-cal").filter((v) => v === "none").length, 0);
  assert.equal(
    values(html, "data-cal").filter((v) => v === "future").length,
    26,
  );
});

test("weeks after the data time in a running quarter have no bar", () => {
  const span = {
    startDay: "2026-10-01",
    endDay: "2027-01-01",
    incomplete: true,
    observedTo: "2026-11-04T19:00:00.000Z",
  };
  const html = activityChart(
    span,
    run("2026-10-01", 35, () => 1),
    "issues",
  );
  // Oct 1–3 and Nov 1–4 are only part of their weeks.
  assert.deepEqual(values(html, "data-bar"), [
    "partial",
    ...Array(4).fill("full"),
    "partial",
    ...Array(8).fill("future"),
  ]);
});

test("a week cut short is drawn lighter and says why on hover", () => {
  const span = { startDay: "2026-07-01", endDay: "2026-08-15" };
  const html = activityChart(
    span,
    run("2026-07-01", 45, () => 1),
    "checks",
  );
  assert.equal(values(html, "data-bar")[0], "partial");
  assert.ok(
    html.includes(`title="${escapeHtml(t("admin.insights.chart.partial"))}"`),
  );
});

test("monthly bars across New Year give January its year", () => {
  const span = { startDay: "2025-07-01", endDay: "2026-07-01" };
  const labels = barLabels(
    activityChart(
      span,
      run("2025-07-01", 365, () => 1),
      "checks",
    ),
  );
  assert.equal(labels.length, 12);
  assert.equal(
    labels[6],
    pacificDay("2026-01-01", { month: "short", year: "numeric" }),
  );
  assert.deepEqual(
    labels.filter((label) => /\d{4}/.test(label)),
    [labels[6]],
  );
});
