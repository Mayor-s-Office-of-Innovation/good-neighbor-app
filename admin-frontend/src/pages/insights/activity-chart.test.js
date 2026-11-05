import { test } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { activityChart, buckets, chartUnit } from "./activity-chart.js";

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

test("weeks start on Monday and the first is clipped to the period", () => {
  // Jul 1, 2026 is a Wednesday, so its week runs Jul 1–5.
  const span = { startDay: "2026-07-01", endDay: "2026-07-20" };
  const list = buckets(
    span,
    run("2026-07-01", 19, () => 1),
    "week",
  );
  assert.deepEqual(
    list.map((b) => [b.start, b.value, b.partial]),
    [
      ["2026-07-01", 5, true],
      ["2026-07-06", 7, false],
      ["2026-07-13", 7, false],
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
  assert.equal(html.match(/insights__cal-none/g)?.length, 9);
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
  const labels = [...html.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels.filter(Boolean), ["Jul", "Aug"]);
});
