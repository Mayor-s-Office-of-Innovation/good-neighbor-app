import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  brandLink,
  click,
  fill,
  focused,
  missing,
  pageError,
  routeTo,
  settle,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/access.templates.js and record.templates.js have no catalog key for this copy, so tests match their English.

const leaveDialog = "#site-unsaved-dialog";
const siteName = 'admin-app wa-input[name="site-name"]';
const RENAMED = "Example Site Renamed";
const heading = () => $("admin-app h1").textContent.trim();
const url = () => window.location.pathname + window.location.search;

/** Hold the first GET matching `pattern` until released. @param {any} api @param {RegExp} pattern */
function holdFirst(api, pattern) {
  const held = gate();
  let reads = 0;
  api.on("GET", pattern, async () => {
    reads += 1;
    if (reads === 1) await held.promise;
    return undefined;
  });
  return held;
}

/** @param {string} type */
function cancelableWindowEvent(type) {
  const event = new window.Event(type, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("leaving edited details asks first; Keep editing stays", async () => {
  await mountAdmin("/sites/s1");
  await fill(siteName, RENAMED);
  await click('a[href="/sites/s1?section=oversight"]');
  assert.equal($(leaveDialog).open, true);
  await click(`${leaveDialog} button[value="keep"]`);
  assert.equal($(leaveDialog).open, false);
  assert.equal(url(), "/sites/s1");
  assert.equal($(siteName).value, RENAMED);
});

test("leaving edited details and choosing Discard leaves", async () => {
  await mountAdmin("/sites/s1");
  await fill(siteName, RENAMED);
  await click('a[href="/sites/s1?section=oversight"]');
  assert.equal($(leaveDialog).open, true);
  await click(`${leaveDialog} button[value="discard"]`);
  assert.equal(url(), "/sites/s1?section=oversight");
  assert.ok(!missing("#site-oversight-form"));
});

test("browser Back with unsaved edits keeps the Site open until discarded", async () => {
  await mountAdmin("/sites");
  await click('admin-app a[href="/sites/s1"]');
  assert.equal(heading(), "Example Site");
  await fill(siteName, RENAMED);
  window.history.back();
  await settle();
  assert.equal($(leaveDialog).open, true);
  assert.equal(url(), "/sites/s1");
  await click(`${leaveDialog} button[value="discard"]`);
  assert.equal(url(), "/sites");
  assert.ok(missing("#site-details-form"));
});

test("unsaved edits in another Site form also guard navigation", async () => {
  await mountAdmin("/sites/s1?section=compliance");
  const perimeter = '#site-perimeter-form wa-textarea[name="perimeter"]';
  await fill(perimeter, "Mission Street from 16th to 17th");
  await click('a[href="/sites/s1?section=details"]');
  assert.equal($(leaveDialog).open, true);
  assert.equal(url(), "/sites/s1?section=compliance");
  assert.equal($(perimeter).value, "Mission Street from 16th to 17th");
});

test("closing the tab asks the browser to confirm only with unsaved edits", async () => {
  await mountAdmin("/sites/s1");
  assert.equal(cancelableWindowEvent("beforeunload"), false);
  await fill(siteName, RENAMED);
  assert.equal(cancelableWindowEvent("beforeunload"), true);
});

test("modified, non-primary and already handled clicks skip in-app routing", async () => {
  await mountAdmin("/sites/s1");
  const link = $('admin-app a[href="/sites/s1?section=oversight"]');
  // Stop happy-dom from following the links routeClick skips.
  const stop = (/** @type {Event} */ event) => event.preventDefault();
  window.addEventListener("click", stop);
  try {
    for (const init of [
      { button: 1 },
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      link.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
      await settle();
      assert.equal(url(), "/sites/s1", JSON.stringify(init));
    }
    window.addEventListener("click", stop, { capture: true });
    link.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    window.removeEventListener("click", stop, { capture: true });
    await click("admin-app h1");
    assert.equal(url(), "/sites/s1");
  } finally {
    window.removeEventListener("click", stop);
  }
});

for (const [section, view, form] of [
  ["staff", "details", "#site-details-form"],
  ["terms", "compliance", "#site-perimeter-form"],
  ["letters", "compliance", "#site-perimeter-form"],
  ["perimeter", "compliance", "#site-perimeter-form"],
])
  test(`the legacy ${section} section opens the ${view} tab`, async () => {
    const { api } = await mountAdmin(`/sites/s1?section=${section}`);
    assert.ok(!missing(form));
    assert.equal(
      $(`a[href="/sites/s1?section=${view}"]`).getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      api.calls("GET", new RegExp(`^sites/s1\\?view=${view}$`)).length,
      1,
    );
  });

test("a slow Program read cannot replace the Site opened after it", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/sites/s1", {
    setup: (api) => (held = holdFirst(api, /^programs\/p1$/)),
  });
  await routeTo("/sites/s2");
  assert.equal(heading(), "Quiet Site");
  held.release();
  await settle();
  assert.equal(heading(), "Quiet Site");
});

test("a slow Program read after leaving for Providers keeps the user's place", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/sites/s1", {
    setup: (api) => (held = holdFirst(api, /^programs\/p1$/)),
  });
  await routeTo("/providers");
  // A late redraw would replace the list and take the user's place in it.
  $('a[href="/providers/v1"]').focus();
  held.release();
  await settle();
  assert.ok(focused('a[href="/providers/v1"]'));
});

test("a slow Program read from an earlier visit cannot replace the Site reopened after it", async () => {
  /** @type {any} */
  let held;
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) => (held = holdFirst(api, /^programs\/p1$/)),
  });
  // Moving s1 to p2 makes the reopened Site read programs/p2, so it can't
  // share the held programs/p1 read.
  Object.assign(api.data.sites[0], { name: RENAMED, leadProgramId: "p2" });
  await routeTo("/sites/s2");
  await routeTo("/sites/s1");
  try {
    assert.equal(heading(), RENAMED);
  } finally {
    held.release();
  }
  await settle();
  assert.equal(heading(), RENAMED);
});

test("a Site read cancelled by navigation leaves no error", async () => {
  const { api } = await mountAdmin("/sites");
  const held = holdFirst(api, /^sites\/s1\?view=details$/);
  await click('admin-app a[href="/sites/s1"]');
  await routeTo("/sites/s2");
  assert.equal(heading(), "Quiet Site");
  held.release();
  await settle();
  assert.equal(pageError(), "");
  assert.equal(heading(), "Quiet Site");
});

test("a Site read cancelled by reopening the same Site leaves no error", async () => {
  const { api } = await mountAdmin("/sites");
  const held = holdFirst(api, /^sites\/s1\?view=details$/);
  await click('admin-app a[href="/sites/s1"]');
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await settle();
  assert.equal(heading(), "Example Site");
  held.release();
  await settle();
  assert.equal(pageError(), "");
  assert.ok(missing("#retry-page-load"));
});

test("a failed Site read shows Retry, which loads the Site", async () => {
  let failures = 1;
  await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("GET", /^sites\/s1\?view=details$/, () =>
        failures-- > 0
          ? { status: 500, json: { error: "internal_error" } }
          : undefined,
      ),
  });
  await click("#retry-page-load");
  assert.equal(heading(), "Example Site");
  assert.ok(missing("#retry-page-load"));
});

test("a Site read that fails after navigating keeps the new page clean", async () => {
  const { api } = await mountAdmin("/sites");
  const held = gate();
  api.on("GET", /^people$/, async () => {
    await held.promise;
    return { status: 500, json: { error: "internal_error" } };
  });
  await click('admin-app a[href="/sites/s1"]');
  await click(brandLink);
  assert.equal(url(), "/sites");
  held.release();
  await settle();
  assert.ok(missing("#retry-page-load"));
  assert.equal(pageError(), "");
});

test("a failed Site read after a link click shows Retry", async () => {
  const { api } = await mountAdmin("/sites");
  api.fail("GET", /^sites\/s1\?view=details$/);
  await click('admin-app a[href="/sites/s1"]');
  assert.ok(!missing("#retry-page-load"));
  assert.equal(pageError(), "Synthetic failure");
});

test("an unknown Site shows no record", async () => {
  await mountAdmin("/sites/missing", {
    setup: (api) =>
      api.on("GET", /^sites\/missing\?view=details$/, { json: {} }),
  });
  assert.ok(missing("#site-details-form"));
  assert.ok(missing("admin-app h1:not([id])"));
  assert.equal(pageError(), "");
  assert.ok(missing("#retry-page-load"));
});

test("a Site whose optional lists are missing still opens", async () => {
  await mountAdmin("/sites/s1?section=access", {
    setup: (api) => {
      api.on("GET", /^sites\/s1\?view=access$/, () => ({
        json: { items: [{ ...api.data.sites[0], sk: "#META" }] },
      }));
      for (const list of ["manager-memberships", "grants", "devices"])
        api.on("GET", new RegExp(`^sites/s1/${list}$`), { json: {} });
      api.on("GET", /^people$/, { json: {} });
      api.on("GET", /^programs\/p1$/, () => ({
        json: { program: api.data.programs[0] },
      }));
    },
  });
  const access = $('section[aria-label="App access"]').textContent;
  assert.ok(access.includes(t("admin.siteManagers.none")));
  assert.ok(access.includes("No devices in use."));
  assert.equal(pageError(), "");
});

test("Site managers known only by email or a missing person still list", async () => {
  await mountAdmin("/sites", {
    setup: (api) =>
      api.data.siteItems.s1.push(
        {
          sk: "MANAGER_MEMBERSHIP#m1",
          type: "managerMembership",
          membershipId: "m1",
          email: "zed@example.org",
          name: "Zed Unlisted",
          status: "active",
        },
        {
          sk: "MANAGER_MEMBERSHIP#m2",
          type: "managerMembership",
          membershipId: "m2",
          personId: "u9",
          email: "gone@example.org",
          status: "active",
        },
        { type: "note", status: "active" },
      ),
  });
  await click('admin-app a[href="/sites/s1"]');
  const managers = $$('[aria-labelledby="site-managers-title"] li');
  assert.equal(
    managers.filter((row) => row.textContent.includes("Zed Unlisted")).length,
    1,
  );
  const gone = managers.find((row) =>
    row.querySelector('[data-remove-manager-membership="m2"]'),
  );
  assert.ok(gone?.textContent.includes("gone@example.org"));
});

test("a Site without a lead program skips the program read", async () => {
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) => {
      api.data.sites[0] = { ...api.data.sites[0], leadProgramId: undefined };
    },
  });
  // Any program ID, so a read of programs/undefined fails the test too.
  assert.equal(api.calls("GET", /^programs\//).length, 0);
  assert.equal(pageError(), "");
});

test("moving between tabs reuses the Site's oversight read", async () => {
  const { api } = await mountAdmin("/sites/s1?section=oversight");
  await click('a[href="/sites/s1?section=details"]');
  assert.ok(!missing("#site-details-form"));
  await click('a[href="/sites/s1?section=access"]');
  assert.ok(missing("#site-details-form"));
  await click('a[href="/sites/s1?section=oversight"]');
  assert.ok(!missing("#site-oversight-form"));
  assert.equal(api.calls("GET", /^sites\/s1\?view=oversight$/).length, 1);
  assert.equal(api.calls("GET", /^people$/).length, 2);
});
