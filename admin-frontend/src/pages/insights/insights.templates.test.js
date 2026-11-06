import { test } from "vitest";
import assert from "node:assert/strict";
import { t as translate } from "../../../../frontend/src/i18n/i18n.js";
import { formatDateTime } from "../../../../frontend/src/i18n/dates.js";
import { escapeHtml } from "../../dom.js";
// Stand-ins for Web Awesome inputs, so a date box holds its value.
import "../../../test-support/admin-dom.js";
import {
  failedView,
  failureText,
  formatDay,
  formatInstant,
  focusSoon,
  freshnessView,
  helpTip,
  monthOfToday,
  perDayText,
  periodForKind,
  periodInterval,
  periodView,
  periodLabel,
  redrawKeepingFocus,
  severityWord,
  shortInstant,
  showLoading,
} from "./insights.templates.js";
import { intervalOf } from "./insights-query.js";

// Markup escapes apostrophes, so copy is compared as the markup holds it.
/** @param {string} key @param {Record<string, string | number>} [params] */
const t = (key, params) => escapeHtml(translate(key, params));

const october = {
  kind: "month",
  startDay: "2026-10-01",
  endDay: "2026-11-01",
  incomplete: false,
};

/** @param {string[]} reasons @param {Record<string, unknown>} [extra] @param {string} [coverageStart] */
const meta = (reasons, extra = {}, coverageStart = "2026-01-01") => ({
  asOf: "2026-11-04T18:00:00.000Z",
  interval: october,
  dataQuality: { reasons, coverageStart },
  ...extra,
});

test("old data gets a notice but still shows its time", () => {
  const html = freshnessView(meta(["stale_snapshot"]));
  assert.ok(html.includes(t("admin.insights.quality.stale")));
  assert.ok(
    html.includes(
      t("admin.insights.dataAsOf", {
        time: formatInstant("2026-11-04T18:00:00.000Z"),
      }),
    ),
  );
});

test("a day key reads as that Pacific day, not the day before", () => {
  assert.equal(
    formatDay("2026-01-01"),
    // 3 PM Pacific on Jan 1.
    formatDateTime("2026-01-01T23:00:00Z", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  );
});

test("a pending page says its data time isn't known yet", () => {
  assert.ok(freshnessView(null).includes(t("admin.insights.dataAsOfPending")));
});

test("records left out for having no time are named once", () => {
  const html = freshnessView(meta(["undated_issues", "undated_checks"]));
  assert.equal(html.split(t("admin.insights.quality.undated")).length, 2);
});

test("a period starting before the data says it's partial", () => {
  const html = freshnessView(meta(["before_coverage"], {}, "2026-10-15"));
  assert.ok(
    html.includes(
      t("admin.insights.quality.beforeCoverage", {
        day: formatDay("2026-10-15"),
      }),
    ),
  );
});

test("fresh data over a finished period has no notices", () => {
  assert.ok(!freshnessView(meta([])).includes("data-insights-quality"));
});

test("a reply with no data time says it isn't known", () => {
  assert.ok(
    freshnessView(meta([], { asOf: null })).includes(
      t("admin.insights.dataAsOfUnknown"),
    ),
  );
});

test("the period type buttons pick the period that holds the one shown", () => {
  const march = { ...october, startDay: "2026-03-01", endDay: "2026-04-01" };
  assert.deepEqual(periodForKind("year", march), { kind: "year", year: 2026 });
  assert.deepEqual(periodForKind("financialYear", march), {
    kind: "financialYear",
    startYear: 2025,
  });
  assert.deepEqual(
    periodForKind("financialYear", {
      ...march,
      startDay: "2026-07-01",
    }),
    { kind: "financialYear", startYear: 2026 },
  );
  assert.equal(periodForKind("custom", march), null);
  assert.deepEqual(periodForKind("quarter", march), {
    kind: "quarter",
    year: 2026,
    quarter: 1,
  });
});

test("Quarter from a running year opens the quarter holding today", () => {
  const year = {
    kind: "year",
    startDay: "2026-01-01",
    endDay: "2027-01-01",
    incomplete: true,
    observedTo: "2026-11-04T19:00:00.000Z",
  };
  assert.deepEqual(periodForKind("quarter", year), {
    kind: "quarter",
    year: 2026,
    quarter: 4,
  });
});

test("a quarter reads as the field app's reports name it", () => {
  assert.equal(
    periodLabel({ ...october, kind: "quarter", startDay: "2026-07-01" }),
    translate("reports.period.quarter", { quarter: 3, year: 2026 }),
  );
});

test("the period types are Month, Quarter, Year, Financial year and Custom, in that order", () => {
  const html = periodView({
    interval: october,
    kind: "quarter",
    draft: { from: "", to: "" },
    error: "",
  });
  assert.deepEqual(
    [...html.matchAll(/data-period-kind="(\w+)" aria-pressed="(\w+)"/g)].map(
      (m) => [m[1], m[2]],
    ),
    [
      ["month", "false"],
      ["quarter", "true"],
      ["year", "false"],
      ["financialYear", "false"],
      ["custom", "false"],
    ],
  );
});

test("a daily average shows one decimal place", () => {
  assert.deepEqual(
    [perDayText(3), perDayText(2.5)],
    [
      translate("admin.insights.perDay", { value: "3.0" }),
      translate("admin.insights.perDay", { value: "2.5" }),
    ],
  );
});

test("Month from a running year opens this month, in Pacific time", () => {
  const year = {
    kind: "year",
    startDay: "2026-01-01",
    endDay: "2027-01-01",
    incomplete: true,
    // 02:00 UTC on Nov 1 is still Oct 31 in San Francisco.
    observedTo: "2026-11-01T02:00:00.000Z",
  };
  assert.deepEqual(periodForKind("month", year), {
    kind: "month",
    month: "2026-10",
  });
});

test("Financial year from a running year opens the one holding today", () => {
  const year = {
    kind: "year",
    startDay: "2026-01-01",
    endDay: "2027-01-01",
    incomplete: true,
    observedTo: "2026-11-04T19:00:00.000Z",
  };
  assert.deepEqual(periodForKind("financialYear", year), {
    kind: "financialYear",
    startYear: 2026,
  });
});

test("financial years read as their two calendar years", () => {
  assert.equal(
    periodLabel({ ...october, kind: "financialYear", startDay: "2025-07-01" }),
    translate("admin.insights.period.fy", { start: "2025", end: "26" }),
  );
});

test("severity bands follow 1–2 Minor, 3 Moderate, 4–5 Severe", () => {
  assert.deepEqual([1, 2, 3, 4, 5, null, 0, 6].map(severityWord), [
    translate("admin.insights.severity.minor"),
    translate("admin.insights.severity.minor"),
    translate("admin.insights.severity.moderate"),
    translate("admin.insights.severity.severe"),
    translate("admin.insights.severity.severe"),
    translate("admin.insights.severity.unknown"),
    // Out of range is unknown, as the server's severityBand says.
    translate("admin.insights.severity.unknown"),
    translate("admin.insights.severity.unknown"),
  ]);
});

test("an error code with its own words uses them; others get a plain retry", () => {
  assert.equal(
    failureText(new Error("future_period"), "Lead."),
    `Lead. ${translate("admin.insights.error.futurePeriod")}`,
  );
  assert.equal(
    failureText(new Error("socket hang up"), "Lead."),
    `Lead. ${translate("admin.insights.error.generic")}`,
  );
});

test("a timed-out read says it took too long, not a plain retry", () => {
  const timeout = Object.assign(new Error("The request took too long."), {
    code: "request_timeout",
  });
  assert.equal(
    failureText(timeout, "Lead."),
    `Lead. ${translate("admin.insights.error.requestTimeout")}`,
  );
});

/**
 * Runs focusSoon on a fake Web Awesome input while `move` changes the page.
 * @param {{ connected?: boolean, move?: (page: { activeElement: string }) => void }} how
 */
async function focusLater({ connected = true, move = () => {} }) {
  /** @type {() => void} */
  let ready = () => {};
  /** @type {string[]} */
  const focused = [];
  const input = {
    isConnected: connected,
    updateComplete: new Promise((resolve) => {
      ready = () => resolve(undefined);
    }),
    focus: () => focused.push("input"),
  };
  const before = globalThis.document;
  const page = { activeElement: "body" };
  globalThis.document = /** @type {any} */ (page);
  try {
    focusSoon(/** @type {any} */ (input));
    move(page);
    ready();
    await input.updateComplete;
    await Promise.resolve();
  } finally {
    globalThis.document = before;
  }
  return focused;
}

test("a late focus doesn't pull the user back once they've moved on", async () => {
  assert.deepEqual(
    await focusLater({
      move: (page) => {
        page.activeElement = "search";
      },
    }),
    [],
  );
});

test("a late focus lands once the input is ready, if the user hasn't moved", async () => {
  assert.deepEqual(await focusLater({}), ["input"]);
});

test("a late focus skips an input a later redraw replaced", async () => {
  assert.deepEqual(await focusLater({ connected: false }), []);
});

test("data problems share one labelled line, and a running period isn't one", () => {
  const html = freshnessView(
    meta(["stale_snapshot", "undated_checks"], {
      interval: {
        ...october,
        incomplete: true,
        observedTo: "2026-10-20T19:00:00.000Z",
      },
    }),
  );
  assert.equal(html.match(/data-insights-quality/g)?.length, 1);
  assert.ok(html.includes(t("admin.insights.quality.label")));
  assert.ok(html.includes(" · "));
  assert.ok(
    !html.includes(
      t("admin.insights.period.incomplete", {
        time: formatInstant("2026-10-20T19:00:00.000Z"),
      }),
    ),
  );
});

const runningOctober = {
  ...october,
  incomplete: true,
  observedTo: "2026-10-20T19:00:00.000Z",
};

test("a running period is marked on its control; Next stays off", () => {
  const html = periodView({
    interval: runningOctober,
    kind: "month",
    draft: { from: "", to: "" },
    error: "",
    dataTime: "2026-10-20T19:00:00.000Z",
  });
  assert.ok(
    html.includes(
      t("admin.insights.period.incomplete", {
        time: formatInstant("2026-10-20T19:00:00.000Z"),
      }),
    ),
  );
  assert.match(html, /data-period-step="1"[^>]*disabled/);
});

test("the period arrows turn off where a step would pass the years the server takes", () => {
  /** @param {import("./insights-query.js").Period} period */
  const arrows = (period) => {
    const box = document.createElement("div");
    box.innerHTML = periodView({
      interval: intervalOf(period),
      kind: period.kind,
      draft: { from: "", to: "" },
      error: "",
    });
    return ["-1", "1"].map(
      (step) =>
        /** @type {HTMLButtonElement} */ (
          box.querySelector(`[data-period-step="${step}"]`)
        ).disabled,
    );
  };
  assert.deepEqual(arrows({ kind: "month", month: "2000-01" }), [true, false]);
  assert.deepEqual(arrows({ kind: "month", month: "2000-02" }), [false, false]);
  assert.deepEqual(arrows({ kind: "year", year: 2999 }), [false, true]);
});

test("the footer's data time is short: no minutes on the hour, no space before AM", () => {
  assert.equal(shortInstant("2026-11-04T19:00:00.000Z"), "Nov 4, 11AM");
  assert.equal(shortInstant("2026-11-04T19:30:00.000Z"), "Nov 4, 11:30AM");
  assert.equal(shortInstant("2026-11-05T01:05:00.000Z"), "Nov 4, 5:05PM");
});

test("a ? names what it explains and holds its text in a popover", () => {
  const html = helpTip("tip-x", "Contacts", "Today's details.");
  assert.ok(html.includes('popovertarget="tip-x"'));
  assert.ok(
    html.includes(
      `aria-label="${t("admin.insights.helpFor", { topic: "Contacts" })}"`,
    ),
  );
  assert.ok(html.includes(`id="tip-x" popover`));
  assert.ok(html.includes(escapeHtml("Today's details.")));
});

test("a running period with no reply yet names no data time, since none has been read", () => {
  const html = periodView({
    interval: runningOctober,
    kind: "month",
    draft: { from: "", to: "" },
    error: "",
  });
  assert.ok(!html.includes("data-period-incomplete"));
});

/** @param {Partial<import("./insights.templates.js").PeriodHost>} host */
const host = (host) => ({
  period: null,
  periodKind: "month",
  periodError: "",
  reply: null,
  periodPicked: () => {},
  ...host,
});

test("after a first load fails, the period controls step from the fallback month", () => {
  assert.equal(periodInterval(host({})), null);
  assert.deepEqual(
    periodInterval(host({ fallback: { kind: "month", month: "2026-10" } }))
      ?.startDay,
    "2026-10-01",
  );
  // The server's own period wins once a reply names one.
  assert.equal(
    periodInterval(
      host({
        fallback: { kind: "month", month: "2026-10" },
        reply: { meta: { interval: { ...october, startDay: "2026-09-01" } } },
      }),
    )?.startDay,
    "2026-09-01",
  );
});

test("the fallback month is the one holding today in Pacific time", () => {
  // 02:00 UTC on Nov 1 is still Oct 31 in San Francisco.
  assert.deepEqual(monthOfToday(new Date("2026-11-01T02:00:00Z")), {
    kind: "month",
    month: "2026-10",
  });
});

test("Retry after a failure shows the spinner, not the old error dimmed", () => {
  const region = document.createElement("div");
  region.innerHTML = failedView("Couldn't load.");
  showLoading(region);
  assert.ok(region.querySelector('[role="status"]'));
  assert.ok(!region.querySelector("[data-insights-failed]"));
  assert.equal(region.hasAttribute("inert"), false);
});

test("old results stay, out of reach, while new ones load", () => {
  const region = document.createElement("div");
  region.innerHTML = "<table data-old></table>";
  showLoading(region);
  assert.ok(region.querySelector("[data-old]"));
  assert.equal(region.hasAttribute("inert"), true);
});

test("a redraw keeps typed dates but doesn't blank the dates it fills in", () => {
  const region = document.createElement("div");
  const markup = () =>
    periodView({
      interval: october,
      kind: "custom",
      draft: { from: "2026-10-01", to: "2026-10-31" },
      error: "",
    });
  region.innerHTML = markup();
  const from = /** @type {any} */ (
    region.querySelector("#insights-period-from")
  );
  const to = /** @type {any} */ (region.querySelector("#insights-period-to"));
  from.value = "2026-10-05";
  to.value = "";
  redrawKeepingFocus(region, markup);
  assert.deepEqual(
    ["#insights-period-from", "#insights-period-to"].map(
      (id) => /** @type {any} */ (region.querySelector(id)).value,
    ),
    ["2026-10-05", "2026-10-31"],
  );
});
