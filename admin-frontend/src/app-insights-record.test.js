import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  focused,
  routeTo,
  settle,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { readVia } from "./pages/insights/record-links.js";
import { categoryWord } from "./pages/insights/raw.templates.js";

const url = () => window.location.pathname + window.location.search;
const crumbs = () =>
  $$("[data-record-trail] li").map((li) =>
    li.textContent.replace(/›/g, "").trim(),
  );

/** A Ctrl-click, which the browser would open in a new tab. @param {string} selector */
async function ctrlClick(selector) {
  // The test's window would follow the link; a new tab would leave this one alone.
  const stay = (/** @type {Event} */ event) => event.preventDefault();
  window.addEventListener("click", stay);
  $(selector).dispatchEvent(
    new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }),
  );
  window.removeEventListener("click", stay);
  await settle();
}

test("going back to a record already on the trail doesn't repeat it", async () => {
  await mountAdmin("/insights/raw/issues/t1?period=2026-10&siteId=s1", {
    insights: true,
  });
  await click("[data-parent-check]");
  // With no list to return to, the root crumb is the record's own list.
  assert.deepEqual(crumbs(), [
    t("admin.insights.raw"),
    t("admin.insights.checks"),
    categoryWord("Unsecured gate"),
    t("admin.insights.check", { id: "c1" }),
  ]);
  await click('[data-record-link="s1|t1"]');
  assert.match(url(), /^\/insights\/raw\/issues\/t1\?/);
  assert.deepEqual(readVia(window.location.search), []);
  assert.deepEqual(crumbs(), [
    t("admin.insights.raw"),
    t("admin.insights.issues"),
    categoryWord("Unsecured gate"),
  ]);
});

test("a record opened from a link without its Site still leads back to it by name", async () => {
  await mountAdmin("/insights/raw/issues/t1?period=2026-10", {
    insights: true,
  });
  await click("[data-parent-check]");
  assert.deepEqual(readVia(window.location.search), [
    { kind: "issue", siteId: "s1", id: "t1" },
  ]);
  assert.equal(
    $('[data-crumb="0"]').textContent,
    categoryWord("Unsecured gate"),
  );
});

test("a Ctrl-click on an Issue row in a Check record leaves this tab where it is", async () => {
  await mountAdmin("/insights/raw/checks/c1?period=2026-10&siteId=s1", {
    insights: true,
  });
  const check = url();
  await ctrlClick('[data-issue-row="t1"] [data-response]');
  assert.equal(url(), check);
  await click('[data-issue-row="t1"] [data-response]');
  assert.match(url(), /^\/insights\/raw\/issues\/t1\?/);
});

test("a Ctrl-click on the list crumb doesn't make a later visit to the list reuse old rows", async () => {
  const { api } = await mountAdmin("/insights/raw/issues?period=2026-10", {
    insights: true,
  });
  const list = url();
  await click('[data-record-link="s1|t1"]');
  await click("#insights-panel-full");
  await ctrlClick('[data-crumb="root"]');
  const asked = api.calls("GET", /^reporting\/issues\?/).length;
  await routeTo(list);
  assert.equal(api.calls("GET", /^reporting\/issues\?/).length, asked + 1);
});

test("a crumb focused while the record loads keeps focus when the names fill in", async () => {
  const held = gate();
  await mountAdmin("/insights/raw/issues/t1?period=2026-10&siteId=s1", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/issues\/t1/, async (/** @type {any} */ r) => {
        await held.promise;
        return api.reply(r);
      }),
  });
  $('[data-crumb="root"]').focus();
  held.release();
  await settle();
  assert.equal(
    $("[data-record-trail] [aria-current]").textContent,
    categoryWord("Unsecured gate"),
  );
  assert.ok(focused('[data-crumb="root"]'));
});
