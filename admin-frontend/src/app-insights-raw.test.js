import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  focused,
  missing,
  routeTo,
  settle,
  tick,
  text,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { adminApi } from "./services/admin-api.js";
import {
  formatDay,
  formatInstant,
  periodLabel,
} from "./pages/insights/insights.templates.js";
import { categoryWord } from "./pages/insights/insights.templates.js";
import { dayHeading } from "./pages/insights/raw.templates.js";

const url = () => window.location.pathname + window.location.search;
/** Download links the page let the browser follow, as a real download would. */
const downloads = /** @type {string[]} */ ([]);
window.addEventListener("click", (/** @type {any} */ event) => {
  const link = event.target.closest?.('a[href^="/mock-downloads/"]');
  if (!link) return;
  if (!event.defaultPrevented) downloads.push(link.getAttribute("href"));
  // happy-dom would navigate the test's window away from the page.
  event.preventDefault();
});

/**
 * A reply the browser already had when its request was cancelled still
 * arrives, so a page must check it's still wanted.
 * @param {(params: Record<string, string>) => boolean} late which requests ignore the abort
 * @param {Promise<unknown>} until when they answer
 */
function lateReplies(late, until) {
  const real = adminApi.reportingIssues;
  vi.spyOn(adminApi, "reportingIssues").mockImplementation((params, signal) =>
    late(params) ? until.then(() => real(params)) : real(params, signal),
  );
}

/** @param {string | Element} target @param {string} key */
async function press(target, key) {
  const element = typeof target === "string" ? $(target) : target;
  element.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
}
/** @param {any} api @param {RegExp} pattern */
const lastQuery = (api, pattern) =>
  new URLSearchParams(api.calls("GET", pattern).at(-1).search);
const recordLinks = () =>
  $$("[data-insights-table] [data-record-link]").map((a) =>
    a.getAttribute("data-record-link"),
  );
const october = periodLabel({
  kind: "month",
  startDay: "2026-10-01",
  endDay: "2026-11-01",
  incomplete: false,
});
const panel = () =>
  /** @type {HTMLDialogElement | null} */ (
    document.querySelector("[data-record-panel]")
  );

/**
 * A click at x on a panel laid out from 500 to 1000 px; happy-dom lays nothing out.
 * @param {string} selector
 * @param {number} x
 */
async function clickAt(selector, x) {
  const box = $(selector);
  box.getBoundingClientRect = () => ({
    left: 500,
    right: 1000,
    top: 0,
    bottom: 800,
  });
  // A real click starts with a press at the same point.
  for (const type of ["pointerdown", "click"])
    box.dispatchEvent(
      new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }),
    );
  await settle();
}

/**
 * insights-mock.js's October Issues, served one a page, so Load more has pages to fetch.
 * @param {any} api
 */
const onePerPage = (api) =>
  api.on("GET", /^reporting\/issues\?/, (/** @type {any} */ r) => {
    const params = new URLSearchParams(r.search);
    const at = Number(params.get("cursor")?.slice(1) ?? "0");
    const reply = api.reply({
      ...r,
      search: `?${[...params]
        .filter(([k]) => k !== "cursor")
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&")}`,
    });
    const all = reply.json.issues;
    reply.json.issues = all.slice(at, at + 1);
    reply.json.nextCursor = at + 1 < all.length ? `p${at + 1}` : null;
    return reply;
  });

test("Issues lists the period's Issues in the server's order, asking for latest activity first", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  assert.equal(
    text("#insights-count"),
    t("admin.insights.raw.issuesCount", { count: 3, period: october }),
  );
  assert.equal(
    lastQuery(api, /^reporting\/issues\?/).get("sort"),
    "latestActivityAt",
  );
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
  assert.deepEqual(
    $$("[data-insights-table] thead th").map((th) => th.textContent.trim()),
    [
      ...["category", "site", "severity", "status", "response"].map((k) =>
        t(`admin.insights.raw.issue.${k}`),
      ),
      t("admin.insights.raw.col.open"),
    ],
  );
  // Each row ends in the Overview table's open marker, so it reads as clickable.
  assert.ok(
    !missing(
      '[data-issue-row="t1"] [data-open-marker] wa-icon[name="chevron-right"]',
    ),
  );
  // The record URL stays on the link, so a new tab still opens the record.
  assert.equal(
    $('[data-record-link="s1|t1"]').getAttribute("href"),
    `/insights/raw/issues/t1?period=2026-10&siteId=s1&return=${encodeURIComponent("/insights/raw/issues?period=2026-10")}`,
  );
});

test("the bar above the list has Group by, then the count, then Export CSV, and the page ends with its interval", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  assert.equal(text("#insights-title"), t("admin.insights.raw"));
  const after = window.Node.DOCUMENT_POSITION_FOLLOWING;
  const count = $("#insights-count");
  assert.ok($("#insights-group").compareDocumentPosition(count) & after);
  assert.ok(count.compareDocumentPosition($("#insights-export")) & after);
  assert.ok(
    $("#insights-export").compareDocumentPosition($("[data-insights-table]")) &
      after,
  );
  assert.equal(
    text("[data-insights-interval]"),
    t("admin.insights.interval", {
      from: formatDay("2026-10-01"),
      to: formatDay("2026-11-01"),
    }),
  );
});

test("the controls run Period, Filter, then the list's own row", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  assert.deepEqual(
    $$("[data-control-label]").map((l) => l.dataset.controlLabel),
    ["period", "filter", "issues"],
  );
  assert.deepEqual(
    $$("wa-select[data-filter]").map((el) => el.dataset.filter),
    [
      "siteIds",
      "providerId",
      "department",
      "programId",
      "managerId",
      "issueStatus",
      "category",
      "severityBand",
      "responseState",
    ],
  );
});

test("the Category select lists only the categories the data holds", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  assert.deepEqual(
    $$('[data-filter="category"] wa-option').map((o) => [
      o.getAttribute("value"),
      o.textContent,
    ]),
    [
      ["", t("admin.insights.raw.category")],
      ["Unsecured gate", categoryWord("Unsecured gate")],
    ],
  );
});

test("the Site select lists every Site by name and narrows to the one picked", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  assert.equal(
    lastQuery(api, /^reporting\/scope-options/).get("include"),
    "sites",
  );
  // Every select fills from one read.
  assert.equal(api.calls("GET", /^reporting\/scope-options/).length, 1);
  assert.ok(
    $$('[data-filter="siteIds"] wa-option')
      .map((o) => o.textContent)
      .includes("Example Site"),
  );
  await fill('wa-select[data-filter="siteIds"]', "s4");
  assert.equal(url(), "/insights/raw/issues?period=2026-10&siteIds=s4");
  assert.equal(lastQuery(api, /^reporting\/issues\?/).get("siteIds"), "s4");
  assert.deepEqual(recordLinks(), ["s4|t9"]);
});

test("a link that names several Sites shows how many in the Site select", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10&siteIds=s1,s4", {
    insights: true,
  });
  const select = $('wa-select[data-filter="siteIds"]');
  assert.equal(select.value, "s1,s4");
  assert.equal(
    $('[data-filter="siteIds"] wa-option[value="s1,s4"]').textContent,
    t("admin.insights.raw.siteCount", { count: 2 }),
  );
});

test("a filter goes in the URL and to the server, and grouping by Site sorts by it", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  await fill('wa-select[data-filter="severityBand"]', "severe");
  assert.equal(
    url(),
    "/insights/raw/issues?period=2026-10&severityBand=severe",
  );
  assert.equal(
    lastQuery(api, /^reporting\/issues\?/).get("severityBand"),
    "severe",
  );
  assert.deepEqual(recordLinks(), ["s1|t1"]);
  await fill("#insights-group", "site");
  assert.equal(lastQuery(api, /^reporting\/issues\?/).get("sort"), "siteName");
  assert.deepEqual(
    $$("[data-group-head]").map((th) => th.textContent.trim()),
    ["Example Site"],
  );
  assert.match(url(), /group=site/);
});

test("Day created puts each Issue under the weekday it was created", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10&group=created", {
    insights: true,
  });
  // t1 was created on Oct 2, 2026.
  const group = $('[data-issue-row="t1"]').closest("[data-issue-group]");
  assert.equal(
    group.querySelector("[data-group-head]").textContent.trim(),
    dayHeading("2026-10-02"),
  );
});

test("no matching Issues says so and offers to clear the filters", async () => {
  await mountAdmin(
    "/insights/raw/issues?period=2026-10&severityBand=moderate&siteIds=s4",
    { insights: true },
  );
  assert.equal(
    text('[data-insights-empty="filtered"] h2'),
    t("admin.insights.raw.noMatchTitle.issues"),
  );
  assert.equal(
    text('[data-insights-empty="filtered"] p'),
    t("admin.insights.raw.noMatch.issues", { period: october }),
  );
  await click("#insights-clear-filters");
  assert.equal(url(), "/insights/raw/issues?period=2026-10");
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
});

test("a period with no Issues says so, with nothing to clear", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-09", { insights: true });
  assert.equal(
    text('[data-insights-empty="none"]'),
    t("admin.insights.raw.none.issues"),
  );
  assert.ok(missing("#insights-clear-filters"));
});

test("Load more adds the next rows below and moves focus to the first new one", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  assert.deepEqual(recordLinks(), ["s1|t2"]);
  await click("#insights-load-more");
  assert.equal(lastQuery(api, /^reporting\/issues\?/).get("cursor"), "p1");
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1"]);
  assert.ok(focused('[data-record-link="s1|t1"]'));
  // The page isn't in the URL; Load more only adds to the list.
  assert.equal(url(), "/insights/raw/issues?period=2026-10");
  await click("#insights-load-more");
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
  assert.ok(missing("#insights-load-more"));
});

test("Load more keeps keyboard focus while its page loads", async () => {
  const held = gate();
  await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: (a) => {
      onePerPage(a);
      a.on(
        "GET",
        /^reporting\/issues\?.*cursor=/,
        async (/** @type {any} */ r) => {
          await held.promise;
          const params = new URLSearchParams(r.search);
          params.delete("cursor");
          const reply = a.reply({ ...r, search: `?${params}` });
          reply.json.issues = reply.json.issues.slice(1, 2);
          reply.json.nextCursor = "p2";
          return reply;
        },
      );
    },
  });
  $("#insights-load-more").focus();
  await click("#insights-load-more");
  assert.ok(focused("#insights-load-more"));
  assert.equal($("#insights-load-more").getAttribute("aria-disabled"), "true");
  held.release();
  await settle();
  assert.ok(focused('[data-record-link="s1|t1"]'));
});

/** happy-dom never scrolls, so a test says when the Load more row comes into view. */
function stubObserver() {
  /** @type {{ callback: Function, targets: Set<Element> }[]} */
  const observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      /** @param {Function} callback */
      constructor(callback) {
        this.callback = callback;
        /** @type {Set<Element>} */
        this.targets = new Set();
        observers.push(this);
      }
      /** @param {Element} el */
      observe(el) {
        this.targets.add(el);
      }
      /** @param {Element} el */
      unobserve(el) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  return {
    watched: () => observers.flatMap((o) => [...o.targets]),
    // A browser can deliver an entry queued before the row was redrawn, so every observer hears it.
    scrollIn: () => {
      for (const o of observers)
        o.callback([{ target: null, isIntersecting: true }], o);
    },
  };
}

test("scrolling near Load more fetches the next page once, leaves focus alone, and stops after the last row", async () => {
  const io = stubObserver();
  const held = gate();
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: (api) => {
      onePerPage(api);
      api.on("GET", /^reporting\/issues\?/, async (/** @type {any} */ r) => {
        if (new URLSearchParams(r.search).get("cursor") === "p1")
          await held.promise;
        return undefined;
      });
    },
  });
  const pages = () =>
    api
      .calls("GET", /^reporting\/issues\?/)
      .filter((/** @type {any} */ c) => /cursor=/.test(c.search)).length;
  assert.deepEqual(recordLinks(), ["s1|t2"]);
  assert.deepEqual(io.watched(), [$("[data-load-more-row]")]);
  // A reader on a row stays there while rows load below it.
  $('[data-record-link="s1|t2"]').focus();
  const before = window.document.activeElement;
  io.scrollIn();
  await tick(0);
  // A load in flight isn't asked for again.
  io.scrollIn();
  await tick(0);
  assert.equal(pages(), 1);
  assert.equal($("#insights-load-more").getAttribute("aria-disabled"), "true");
  held.release();
  await settle();
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1"]);
  assert.ok(window.document.activeElement === before);
  // The button is still there for keyboard and screen-reader users.
  assert.ok(!missing("#insights-load-more"));
  io.scrollIn();
  await settle();
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
  assert.ok(missing("#insights-load-more"));
  assert.deepEqual(io.watched(), []);
  assert.equal(pages(), 2);
});

test("a filter change starts the list again from its first rows", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  await click("#insights-load-more");
  await fill('wa-select[data-filter="issueStatus"]', "open");
  assert.equal(lastQuery(api, /^reporting\/issues\?/).get("cursor"), null);
  assert.deepEqual(recordLinks(), ["s1|t2"]);
});

test("new data while loading more starts the list again and says why", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  api.on("GET", /^reporting\/issues\?.*cursor=p1/, {
    status: 409,
    json: { error: "snapshot_changed" },
  });
  await click("#insights-load-more");
  assert.equal(
    text("[data-insights-notice]"),
    t("admin.insights.raw.restarted"),
  );
  assert.equal(lastQuery(api, /^reporting\/issues\?/).get("cursor"), null);
  assert.deepEqual(recordLinks(), ["s1|t2"]);
});

test("a failed reload keeps the last rows under the out-of-date banner, and Try again brings fresh ones", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  api.fail("GET", /^reporting\/issues\?.*severityBand=minor/, 503);
  await fill('wa-select[data-filter="severityBand"]', "minor");
  assert.equal(text("[data-insights-stale] p"), t("admin.insights.raw.stale"));
  // insights__stale dims a loading region's children; the banner must stay readable.
  assert.equal(
    $("[data-insights-stale]").closest(".insights__stale") === null,
    true,
  );
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
  // Old rows can't be exported as if they answered the new filters.
  assert.equal($("#insights-export").getAttribute("aria-disabled"), "true");
  api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-retry");
  assert.ok(missing("[data-insights-stale]"));
  assert.deepEqual(recordLinks(), ["s4|t9"]);
});

test("a first load that fails says why, and Retry brings the list", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: (a) =>
      a.fail("GET", /^reporting\/issues/, 503, "snapshot_unavailable"),
  });
  assert.ok(
    text('[data-region="results"]').includes(
      t("admin.insights.error.snapshotUnavailable"),
    ),
  );
  assert.equal($("#insights-export").getAttribute("aria-disabled"), "true");
  api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-retry");
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
});

test("a reply that lands after a newer filter is dropped", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  const held = gate();
  lateReplies((params) => params.severityBand === "minor", held.promise);
  const slow = fill('wa-select[data-filter="severityBand"]', "minor");
  await settle();
  await fill('wa-select[data-filter="severityBand"]', "severe");
  held.release();
  await slow;
  await settle();
  assert.deepEqual(recordLinks(), ["s1|t1"]);
});

test("a row opens its record in the side panel; Esc closes it and focus goes back to the row", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  const list = url();
  await click('[data-record-link="s1|t1"]');
  assert.equal(panel()?.open, true);
  assert.equal(
    panel()?.getAttribute("aria-label"),
    t("admin.insights.panel.issue"),
  );
  assert.equal(text("#insights-panel-title"), categoryWord("Unsecured gate"));
  // The list keeps its place and URL behind the panel.
  assert.equal(url(), list);
  assert.ok(!missing("[data-insights-table]"));
  await press("#insights-panel", "Escape");
  assert.ok(!panel());
  assert.ok(focused('[data-record-link="s1|t1"]'));
});

test("× and a click outside the panel close it too", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  await click('[data-issue-row="t9"] [data-response]');
  assert.equal(panel()?.open, true);
  assert.equal(
    $("#insights-panel-close").getAttribute("aria-label"),
    t("common.close"),
  );
  await click("#insights-panel-close");
  assert.ok(!panel());
  assert.ok(focused('[data-record-link="s4|t9"]'));
  await click('[data-record-link="s4|t9"]');
  // A short record leaves the dialog itself showing inside the panel; a click there stays.
  await clickAt("#insights-panel", 700);
  assert.equal(panel()?.open, true);
  await clickAt("#insights-panel", 100);
  assert.ok(!panel());
});

test("links inside the panel switch it to that record", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  const list = url();
  await click('[data-record-link="s1|t1"]');
  await click("#insights-panel [data-parent-check]");
  assert.equal(
    panel()?.getAttribute("aria-label"),
    t("admin.insights.panel.check"),
  );
  assert.equal(
    text("#insights-panel-title"),
    t("admin.insights.check", { id: "c1" }),
  );
  await click('#insights-panel [data-record-link="s1|t1"]');
  assert.equal(text("#insights-panel-title"), categoryWord("Unsecured gate"));
  assert.equal(url(), list);
});

test("Open full record goes to the record; its root crumb returns to the list with focus on the row", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10&severityBand=severe", {
    insights: true,
  });
  const list = url();
  await click('[data-record-link="s1|t1"]');
  assert.equal(text("#insights-panel-full"), t("admin.insights.panel.open"));
  await click("#insights-panel-full");
  assert.match(url(), /^\/insights\/raw\/issues\/t1\?/);
  assert.equal(text("h1"), categoryWord("Unsecured gate"));
  assert.deepEqual(
    $$("[data-record-trail] li").map((li) =>
      li.textContent.replace(/›/g, "").trim(),
    ),
    [
      t("admin.insights.raw"),
      t("admin.insights.issues"),
      categoryWord("Unsecured gate"),
    ],
  );
  // The Raw data crumb is a level too: the list with no filters.
  assert.equal(
    $('[data-crumb="raw"]').getAttribute("href"),
    "/insights/raw/issues?period=2026-10",
  );
  await click('[data-crumb="root"]');
  assert.equal(url(), list);
  assert.ok(focused('[data-record-link="s1|t1"]'));
});

test("back from a record reached by Load more restores every loaded row and its focus", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  await click("#insights-load-more");
  await click("#insights-load-more");
  await click('[data-record-link="s4|t9"]');
  await click("#insights-panel-full");
  const asked = api.calls("GET", /^reporting\/issues\?/).length;
  await click('[data-crumb="root"]');
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1", "s4|t9"]);
  assert.ok(focused('[data-record-link="s4|t9"]'));
  // Restored from the session, not fetched page by page again.
  assert.equal(api.calls("GET", /^reporting\/issues\?/).length, asked);
});

test("Load more still works after coming back to a list with rows left to load", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  await click('[data-record-link="s1|t2"]');
  await click("#insights-panel-full");
  await click('[data-crumb="root"]');
  assert.deepEqual(recordLinks(), ["s1|t2"]);
  await click("#insights-load-more");
  assert.deepEqual(recordLinks(), ["s1|t2", "s1|t1"]);
});

test("each record opened from another is a history entry, so browser Back steps back one record", async () => {
  await mountAdmin("/insights/raw/issues/t1?period=2026-10&siteId=s1", {
    insights: true,
  });
  const issue = url();
  await click("[data-parent-check]");
  assert.match(url(), /^\/insights\/raw\/checks\/c1\?/);
  const check = url();
  window.history.back();
  await settle();
  assert.equal(url(), issue);
  window.history.forward();
  await settle();
  assert.equal(url(), check);
});

test("an Issue record shows its facts, response facts with a ? and a timeline in time order", async () => {
  await mountAdmin("/insights/raw/issues/t1?period=2026-10&siteId=s1", {
    insights: true,
    // Resolved before its first response, so time order differs from field order.
    setup: (api) =>
      api.on("GET", /^reporting\/issues\/t1/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        reply.json.issue.resolvedAt = "2026-10-02T18:00:00.000Z";
        return reply;
      }),
  });
  assert.equal(
    text("[data-record-meta]"),
    `${t("admin.insights.issue", { id: "t1" })} · Example Site`,
  );
  assert.equal(
    text('[data-fact="severity"] dd'),
    t("admin.insights.raw.severityLevel", {
      word: t("admin.insights.severity.severe"),
      level: 4,
    }),
  );
  assert.equal(
    text('[data-fact="parentCheck"] a'),
    t("admin.insights.check", { id: "c1" }),
  );
  assert.equal(
    text('[data-fact="deadline"] dd'),
    formatInstant("2026-10-05T17:00:00.000Z"),
  );
  assert.equal(
    text('[data-fact="responseState"] dt'),
    t("admin.insights.record.responseState"),
  );
  assert.equal(
    text("#insights-record-tip-response"),
    t("admin.insights.record.responseHelp"),
  );
  assert.deepEqual(
    $$("[data-timeline] li").map((li) => li.dataset.event),
    ["created", "resolved", "firstResponse"],
  );
  assert.equal(
    text('[data-fact="action"] dd'),
    t("admin.insights.record.action.onsite"),
  );
  // Help sits in "?" popovers only, not in the page's own text.
  const page = $("insights-record").cloneNode(true);
  for (const tip of page.querySelectorAll("[popover]")) tip.remove();
  assert.ok(
    !page.textContent.includes(t("admin.insights.record.responseHelp")),
  );
});

test("an Issue with no Check on record says so instead of linking", async () => {
  await mountAdmin("/insights/raw/issues/t9?siteId=s4", { insights: true });
  assert.equal(
    text('[data-fact="parentCheck"] dd'),
    t("admin.insights.record.noCheck"),
  );
  assert.equal(
    text('[data-fact="firstResponse"] dd'),
    t("admin.insights.record.responseUnknown"),
  );
});

test("a Check record names its kind, Site and time, and lists its Issues", async () => {
  await mountAdmin("/insights/raw/checks/c1?siteId=s1", { insights: true });
  assert.equal(text("h1"), t("admin.insights.check", { id: "c1" }));
  assert.equal(
    text("[data-record-meta]"),
    [
      t("admin.insights.raw.source.perimeter"),
      "Example Site",
      t("admin.insights.record.completedAt", {
        time: formatInstant("2026-10-02T17:00:00.000Z"),
      }),
    ].join(" · "),
  );
  assert.deepEqual(
    $$("[data-fact]").map((f) => f.dataset.fact),
    ["recordedState", "started", "completed"],
  );
  assert.equal(
    text("[data-check-issues-head]"),
    t("admin.insights.record.issuesFrom", { count: 1 }),
  );
  assert.ok(!missing('[data-issue-row="t1"]'));
});

test("an unfinished Check says when it started", async () => {
  await mountAdmin("/insights/raw/checks/c1?siteId=s1", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/checks\/c1/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        Object.assign(reply.json.check, {
          state: "unfinished",
          completedAt: null,
        });
        return reply;
      }),
  });
  assert.ok(
    text("[data-record-meta]").endsWith(
      t("admin.insights.raw.startedAt", {
        time: formatInstant("2026-10-02T16:50:00.000Z"),
      }),
    ),
  );
});

test("a record the data doesn't have says so, and a failed one can retry", async () => {
  await mountAdmin("/insights/raw/issues/zz?siteId=s1", { insights: true });
  assert.equal(
    text('[data-insights-empty="issue_not_found"]'),
    t("admin.insights.record.notFound.issue"),
  );
  let failing = true;
  await mountAdmin("/insights/raw/issues/t1?siteId=s1", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^reporting\/issues\/t1/, (/** @type {any} */ r) =>
        failing ? { status: 503, json: { error: "unavailable" } } : a.reply(r),
      ),
  });
  assert.ok(missing('[data-fact="status"]'));
  failing = false;
  await click("#insights-retry");
  assert.equal(text("h1"), categoryWord("Unsecured gate"));
  assert.ok(!missing('[data-fact="status"]'));
});

test("Export CSV asks first, then sends every matching row's query", async () => {
  const { api } = await mountAdmin(
    "/insights/raw/issues?period=2026-10&severityBand=severe",
    { insights: true },
  );
  await click("#insights-export");
  assert.equal($("#insights-export-dialog").open, true);
  assert.equal(
    text("#insights-export-title"),
    t("admin.insights.export.title.issues", { count: 1 }),
  );
  assert.equal(
    text("#insights-export-copy"),
    t("admin.insights.export.body.issues", { count: 1 }),
  );
  assert.equal(
    text("#insights-export-confirm"),
    t("admin.insights.export.confirm"),
  );
  assert.equal(api.calls("POST", /^reporting\/exports$/).length, 0);
  await click("#insights-export-confirm");
  const [post] = api.calls("POST", /^reporting\/exports$/);
  assert.deepEqual(post.body, {
    dataset: "issues",
    period: "month",
    month: "2026-10",
    severityBand: "severe",
    sort: "latestActivityAt",
  });
  assert.match(post.headers["idempotency-key"], /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(text("#insights-export"), t("admin.insights.export.exporting"));
  assert.equal($("#insights-export").getAttribute("aria-disabled"), "true");
  await click("#insights-export");
  assert.ok(missing("#insights-export-dialog"));
  await tick(2000);
  assert.equal($("#insights-export-done").open, true);
  assert.equal(
    text("#insights-export-done h2"),
    t("admin.insights.export.done"),
  );
  assert.equal(
    $("#insights-export-download").getAttribute("href"),
    "/mock-downloads/insights-issues.csv",
  );
  downloads.length = 0;
  await click("#insights-export-download");
  // The browser downloads the file; the page only closes the dialog.
  assert.deepEqual(downloads, ["/mock-downloads/insights-issues.csv"]);
  assert.ok(missing("#insights-export-done"));
  assert.equal(text("#insights-export"), t("admin.insights.export.button"));
});

test("an export the server refuses as too big says what to change", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("POST", /^reporting\/exports$/, {
        status: 413,
        json: { error: "export_too_large" },
      }),
  });
  await click("#insights-export");
  await click("#insights-export-confirm");
  assert.equal(
    text("[data-job-error]"),
    t("admin.insights.export.error.exportTooLarge"),
  );
  assert.ok(!missing("#insights-export-retry"));
});

test("Export CSV is off with nothing to export, and says why to screen readers", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-09", { insights: true });
  assert.equal($("#insights-export").getAttribute("aria-disabled"), "true");
  assert.equal(
    $("#insights-export").getAttribute("aria-describedby"),
    "insights-export-why",
  );
  assert.equal(
    text("#insights-export-why"),
    t("admin.insights.export.nothing"),
  );
  await click("#insights-export");
  assert.ok(missing("#insights-export-dialog"));
});

test("Checks list perimeter Checks, filter by recorded state and mute unfinished ones", async () => {
  const { api } = await mountAdmin("/insights/raw/checks?period=2026-10", {
    insights: true,
    // A second Check, started 20 minutes after c1 and never finished.
    setup: (a) =>
      a.on("GET", /^reporting\/checks\?/, (/** @type {any} */ r) => {
        const reply = a.reply(r);
        const state = new URLSearchParams(r.search).get("state");
        if (state !== "completed")
          reply.json.checks.push({
            checkId: "c2",
            siteId: "s1",
            siteName: "Example Site",
            source: "perimeter",
            state: "unfinished",
            startedAt: "2026-10-02T17:10:00.000Z",
            completedAt: null,
            activityAt: "2026-10-02T17:10:00.000Z",
            issues: 0,
          });
        reply.json.total = reply.json.checks.length;
        return reply;
      }),
  });
  assert.equal(
    lastQuery(api, /^reporting\/checks\?/).get("source"),
    "perimeter",
  );
  assert.deepEqual(recordLinks(), ["s1|c1", "s1|c2"]);
  assert.equal(
    text(
      '[data-check-row="c2"] td[data-label="' +
        t("admin.insights.raw.check.time") +
        '"]',
    ),
    t("admin.insights.raw.startedAt", {
      time: formatInstant("2026-10-02T17:10:00.000Z"),
    }),
  );
  // Only the unfinished Check's time and state are muted.
  assert.equal($$('[data-check-row="c2"] [data-muted]').length, 2);
  assert.ok(missing('[data-check-row="c1"] [data-muted]'));
  assert.equal(text("#insights-tip-checks"), t("admin.insights.raw.checksTip"));
  await fill('wa-select[data-filter="state"]', "unfinished");
  assert.equal(
    lastQuery(api, /^reporting\/checks\?/).get("state"),
    "unfinished",
  );
  assert.deepEqual(recordLinks(), ["s1|c2"]);
});

test("Issues and Checks are links that keep the period", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10&severityBand=severe", {
    insights: true,
  });
  assert.equal(
    $('[data-insights-raw="checks"]').getAttribute("href"),
    "/insights/raw/checks?period=2026-10",
  );
  assert.equal(
    $('[data-insights-raw="issues"]').getAttribute("aria-current"),
    "page",
  );
});

test("Esc with a ? tip open closes the tip only, so the record stays open", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  await click('[data-record-link="s1|t1"]');
  const tip = $("#insights-panel-tip-response");
  let hidden = false;
  // happy-dom has no popovers, so the tip is marked open by hand.
  const own = tip.matches.bind(tip);
  tip.matches = (/** @type {string} */ selector) =>
    selector === ":popover-open" ? !hidden : own(selector);
  tip.hidePopover = () => {
    hidden = true;
  };
  await press("#insights-panel", "Escape");
  assert.equal(hidden, true);
  assert.equal(panel()?.open, true);
  await press("#insights-panel", "Escape");
  assert.ok(!panel());
});

test("an Issue in the panel shows its photos and notes; a photo opens full size and Esc closes only the photo", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  await click('[data-record-link="s1|t1"]');
  const thumbs = $$("#insights-panel [data-photo-open]");
  assert.deepEqual(
    thumbs.map((b) => b.getAttribute("aria-label")),
    [
      t("admin.insights.record.photoOpen.check", {
        time: formatInstant("2026-10-02T17:01:00.000Z"),
      }),
      t("admin.insights.record.photoOpen.update", {
        time: formatInstant("2026-10-03T17:00:00.000Z"),
      }),
    ],
  );
  assert.equal(
    text('#insights-panel [data-note-source="update"]'),
    `${formatInstant("2026-10-03T17:00:00.000Z")} ${t("admin.insights.record.noteFrom.update")} Synthetic note`,
  );
  await click(thumbs[1]);
  const viewer = $("#insights-photo-viewer");
  assert.equal(viewer.open, true);
  assert.equal(
    viewer.querySelector("img").getAttribute("alt"),
    t("admin.insights.record.photoAlt.update"),
  );
  await press(viewer, "Escape");
  assert.ok(missing("#insights-photo-viewer"));
  assert.equal(panel()?.open, true);
  assert.ok(window.document.activeElement === thumbs[1]);
});

test("a Check record page lists its description as a note under its photo", async () => {
  await mountAdmin("/insights/raw/checks/c1?period=2026-10&siteId=s1", {
    insights: true,
  });
  assert.equal($$("[data-photo-open]").length, 1);
  assert.equal(
    text('[data-note-source="check"]'),
    `${formatInstant("2026-10-02T17:02:00.000Z")} ${t("admin.insights.record.noteFrom.check")} Synthetic description`,
  );
  await click("[data-photo-open]");
  await click("#insights-photo-viewer [data-photo-close]");
  assert.ok(missing("#insights-photo-viewer"));
  assert.ok(focused("[data-photo-open]"));
});

test("a compliance manager sees the record without a photos section, as the admin's photos are supervisors'", async () => {
  await mountAdmin("/insights/raw/issues/t1?period=2026-10&siteId=s1", {
    insights: true,
    role: "compliance-manager",
  });
  assert.ok(!missing('[data-fact="severity"]'));
  assert.ok(missing("[data-record-photos]"));
});

test("an Issue opened from a Check's panel shows a trail back to the Check, and keeps it on its full record", async () => {
  await mountAdmin("/insights/raw/checks?period=2026-10", { insights: true });
  assert.ok(!missing('[data-check-row="c1"] [data-open-marker]'));
  await click('[data-record-link="s1|c1"]');
  assert.ok(missing("#insights-panel [data-panel-trail]"));
  // Each Issue in the Check carries the same open marker as the lists.
  assert.ok(
    !missing('#insights-panel [data-issue-row="t1"] [data-open-marker]'),
  );
  await click('#insights-panel [data-record-link="s1|t1"]');
  const trail = $$("#insights-panel [data-panel-trail] li");
  assert.equal(
    trail[0].textContent.replace(/›/g, "").trim(),
    t("admin.insights.check", { id: "c1" }),
  );
  // The open Issue ends the trail, marked as the current place.
  assert.equal(trail.length, 2);
  assert.ok(trail[1].querySelector('[aria-current="page"]'));
  await click("#insights-panel [data-panel-trail] a");
  assert.equal(
    text("#insights-panel-title"),
    t("admin.insights.check", { id: "c1" }),
  );
  assert.ok(missing("#insights-panel [data-panel-trail]"));
  await click('#insights-panel [data-record-link="s1|t1"]');
  await click("#insights-panel-full");
  assert.match(url(), /^\/insights\/raw\/issues\/t1\?/);
  assert.deepEqual(
    $$("[data-record-trail] li").map((li) =>
      li.textContent.replace(/›/g, "").trim(),
    ),
    [
      t("admin.insights.raw"),
      t("admin.insights.checks"),
      t("admin.insights.check", { id: "c1" }),
      categoryWord("Unsecured gate"),
    ],
  );
  await click('[data-crumb="0"]');
  assert.match(url(), /^\/insights\/raw\/checks\/c1\?/);
});

test("a click anywhere on an Issue row inside a Check's panel opens that Issue", async () => {
  await mountAdmin("/insights/raw/checks?period=2026-10", { insights: true });
  await click('[data-record-link="s1|c1"]');
  await click('#insights-panel [data-issue-row="t1"] [data-response]');
  assert.equal(text("#insights-panel-title"), categoryWord("Unsecured gate"));
});

test("a filter change during Load more, then a failed load, leaves no stuck Load more", async () => {
  const held = gate();
  await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: (api) => {
      onePerPage(api);
      api.on("GET", /^reporting\/issues\?/, async (/** @type {any} */ r) =>
        new URLSearchParams(r.search).get("severityBand")
          ? { status: 503, json: { error: "unavailable" } }
          : undefined,
      );
    },
  });
  lateReplies((params) => !!params.cursor, held.promise);
  $("#insights-load-more").click();
  await tick(0);
  await fill('wa-select[data-filter="severityBand"]', "severe");
  held.release();
  await settle();
  assert.ok(!missing("[data-insights-stale]"));
  // A page of the old filters can't follow the new ones, so Retry is the way on.
  assert.ok(missing("#insights-load-more"));
  assert.deepEqual(recordLinks(), ["s1|t2"]);
});

test("browser Back from a record restores the list, but a fresh visit loads it again", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  const list = url();
  await click('[data-record-link="s1|t1"]');
  await click("#insights-panel-full");
  const asked = api.calls("GET", /^reporting\/issues\?/).length;
  window.history.back();
  await settle();
  assert.equal(url(), list);
  assert.equal(api.calls("GET", /^reporting\/issues\?/).length, asked);
  assert.ok(focused('[data-record-link="s1|t1"]'));
  // The Raw data tab to the same address is a new visit, so the data is read again.
  await routeTo(list);
  assert.equal(api.calls("GET", /^reporting\/issues\?/).length, asked + 1);
});

test("the Response filter offers No response time, which rows can show", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  assert.ok(
    $$('[data-filter="responseState"] wa-option')
      .map((o) => o.getAttribute("value"))
      .includes("notTimed"),
  );
  await fill('wa-select[data-filter="responseState"]', "notTimed");
  assert.equal(
    lastQuery(api, /^reporting\/issues\?/).get("responseState"),
    "notTimed",
  );
});

test("on phones the filters fold behind a button that says how many are on", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10&severityBand=severe", {
    insights: true,
  });
  const toggle = $("#insights-filters-toggle");
  assert.equal(
    toggle.textContent.trim(),
    t("admin.insights.raw.filtersOn", { count: 1 }),
  );
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await click("#insights-filters-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok($("#insights-controls").hasAttribute("data-open"));
  await fill('wa-select[data-filter="severityBand"]', "");
  assert.equal(toggle.textContent.trim(), t("admin.insights.raw.filters"));
});

test("Load more says how many rows of the total are showing", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  assert.equal(
    text("[data-shown]"),
    t("admin.insights.raw.showing", { shown: 1, total: 3 }),
  );
  await click("#insights-load-more");
  assert.equal(
    text("[data-shown]"),
    t("admin.insights.raw.showing", { shown: 2, total: 3 }),
  );
});

test("a new filter drops the old interval while the list loads", async () => {
  const held = gate();
  await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/issues\?/, async (/** @type {any} */ r) => {
        if (new URLSearchParams(r.search).get("severityBand"))
          await held.promise;
        return undefined;
      }),
  });
  assert.ok(text("[data-insights-interval]"));
  await fill('wa-select[data-filter="severityBand"]', "severe");
  assert.equal(text("[data-insights-interval]"), "");
  held.release();
  await settle();
  assert.ok(text("[data-insights-interval]"));
});

test("a restarted list that then fails to load doesn't claim it started again", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
    setup: onePerPage,
  });
  api.on("GET", /^reporting\/issues\?/, (/** @type {any} */ r) =>
    new URLSearchParams(r.search).get("cursor")
      ? { status: 409, json: { error: "snapshot_changed" } }
      : { status: 503, json: { error: "unavailable" } },
  );
  await click("#insights-load-more");
  assert.ok(!missing("[data-insights-stale]"));
  assert.ok(missing("[data-insights-notice]"));
});

test("a failed load with no rows to keep drops the old count", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-09", {
    insights: true,
  });
  assert.ok(text("#insights-count"));
  api.fail("GET", /^reporting\/issues\?.*severityBand=minor/, 503);
  await fill('wa-select[data-filter="severityBand"]', "minor");
  assert.equal(text("#insights-count"), "");
});

test("selecting text in a row doesn't open the row", async () => {
  await mountAdmin("/insights/raw/issues?period=2026-10", { insights: true });
  const selection = /** @type {any} */ ("Example Site");
  vi.spyOn(window.document, "getSelection").mockReturnValue(selection);
  await click('[data-issue-row="t9"] [data-response]');
  assert.ok(!panel());
});
