import { beforeEach, describe, test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  alertText,
  brandLink,
  click,
  fill,
  focused,
  missing,
  pageError,
  pageText,
  routeTo,
  settle,
  tick,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { openSitePage } from "../test-support/site-pages.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import {
  accessData,
  managerData,
} from "../../e2e/admin-tests/site-access-helpers.js";
import {
  complianceData,
  compliancePath,
} from "../../e2e/admin-tests/site-compliance-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { createAdminCatalog } from "./admin-catalog.js";

// pages/site/access.templates.js and record.templates.js have no catalog key for this copy, so tests match their English.

const leaveDialog = "#site-unsaved-dialog";
const siteName = 'admin-site-page wa-input[name="site-name"]';
const RENAMED = "Example Site Renamed";
const heading = () => $("admin-site-page h1").textContent.trim();
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

test("a Site read that finishes after leave() doesn't let the page open, even at the same address", async () => {
  const { page, api } = await openSitePage("/sites/s1");
  // The lead Program read comes after the Site read, which leave() aborts.
  const held = holdFirst(api, /^programs\//);
  const opening = page.open({ name: "site", id: "s1" });
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  assert.equal(await opening, false);
});

test("a Site page mount given a catalog shows that catalog's Providers", async () => {
  const catalog = createAdminCatalog();
  catalog.seed({
    providers: [
      { providerId: "v9", name: "Seeded Provider", status: "active" },
    ],
    programs: [],
    oversightOptions: { departments: [], systemsOfCare: [] },
    programManagers: [],
  });
  await openSitePage("/sites/s1", { catalog });
  const provider = 'wa-select[name="lead-provider-id"] wa-option';
  assert.ok(!missing(`${provider}[value="v9"]`));
  assert.ok(missing(`${provider}[value="v1"]`));
});

test("an error in <admin-app>'s error line keeps the Site's unsaved edits", async () => {
  await mountAdmin("/sites/s1");
  await fill(siteName, RENAMED);
  // What a failed Site action does; <admin-app> redraws and reattaches the page.
  $("admin-site-page").reportError(new Error("Something failed"));
  await settle();
  assert.equal(pageError(), "Something failed");
  assert.equal($(siteName).value, RENAMED);
  assert.equal($("#site-details-form").dataset.isDirty, "true");
});

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
  await openSitePage("/sites/s1");
  const link = $('admin-site-page a[href="/sites/s1?section=oversight"]');
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
    await click("admin-site-page h1");
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
    const { api } = await openSitePage(`/sites/s1?section=${section}`);
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

// Site page tests that need <admin-app>: its error line and notices, its
// unsaved-changes dialog, its directory, or a route another page shows.

const ACCESS = "/sites/s1?section=access";
const setting311 =
  '#site-deliberate-311-form wa-select[name="deliberate-311-enabled"]';

/** @param {string} path @param {Parameters<typeof mountAdmin>[1]} [options] */
const openAccessInApp = (path, options = {}) =>
  mountAdmin(path, { data: managerData(), ...options });

/** @param {string} path @param {Parameters<typeof mountAdmin>[1]} [options] */
const openManagerInApp = (path, options = {}) =>
  mountAdmin(path, { data: managerData(), ...options });

const openNewManager = () => click("#create-site-manager");

async function fillNewManager() {
  for (const [name, value] of [
    ["new-manager-first-name", "Riley"],
    ["new-manager-last-name", "New"],
    ["new-manager-phone", "4155550109"],
    ["new-manager-email", "riley@example.org"],
  ])
    await fill(`#new-site-manager-form wa-input[name="${name}"]`, value);
}

test("a manager created from a Site appears in the manager directory", async () => {
  await openAccessInApp("/managers");
  await routeTo("/sites/s1");
  await openNewManager();
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  await routeTo("/managers");
  assert.match(
    $('[aria-labelledby="managers-title"]').textContent,
    /Riley New/,
  );
});

test("a failed enrollment clears a stale page banner instead of repeating its toast there", async () => {
  const { api } = await openAccessInApp(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.fail(
        "DELETE",
        /^sites\/s1\/grants\/g1$/,
        404,
        "manager_grant_not_found",
      ),
  });
  await click('[data-cancel-manager-grant="g1"]');
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "manager_grant_not_found");
  api.fail("POST", /manager-grants$/, 409, "manager_grant_conflict");
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="link"]');
  assert.ok(alertText().includes(t("admin.toast.requestFailed")));
  assert.equal(pageError(), "");
});

test("a page error clears when a link is sent, and a late refresh is dropped", async () => {
  const data = accessData();
  data.grants.push({
    siteId: "s3",
    grantId: "g5",
    issuedTo: "morgan@example.org",
    status: "pending",
  });
  const { api } = await openAccessInApp(ACCESS, {
    data,
    setup: (api) =>
      api.fail(
        "DELETE",
        /^sites\/s1\/grants\/g1$/,
        404,
        "manager_grant_not_found",
      ),
  });
  await click('[data-cancel-manager-grant="g1"]');
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.match(pageText(), /manager_grant_not_found/);
  const held = gate();
  api.on("POST", /manager-grants$/, {
    json: { grant: { grantId: "g9", deliveryStatus: "accepted" } },
  });
  api.on("GET", /^sites\/s1\/grants$/, async () => {
    await held.promise;
    return { json: { grants: [] } };
  });
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="link"]');
  assert.doesNotMatch(pageText(), /manager_grant_not_found/);
  await routeTo("/sites/s3?section=access");
  assert.equal(heading(), "North Site");
  assert.ok(!missing('[data-cancel-manager-grant="g5"]'));
  held.release();
  await settle();
  assert.ok(!missing('[data-cancel-manager-grant="g5"]'));
  assert.ok(missing('[data-cancel-manager-grant="g1"]'));
  assert.equal(heading(), "North Site");
});

test("a legacy assignment whose link fails keeps its new membership for the retry", async () => {
  let grants = 0;
  const { api } = await openAccessInApp(ACCESS, {
    data: accessData(),
    setup: (api) => {
      api.on("POST", /^sites\/s1\/manager-memberships$/, {
        json: {
          membership: {
            membershipId: "m40",
            name: "Alex Example",
            email: "alex@example.org",
            status: "active",
          },
        },
      });
      api.on("POST", /^sites\/s1\/manager-grants$/, () =>
        ++grants === 1
          ? { status: 409, json: { error: "manager_grant_conflict" } }
          : { json: { grant: { grantId: "g9", deliveryStatus: "accepted" } } },
      );
    },
  });
  await click(
    '[data-issue-manager-grant="legacy:u1"][data-delivery-mode="link"]',
  );
  assert.ok(alertText().includes(t("admin.toast.partial")));
  await click('[data-issue-manager-grant="m40"][data-delivery-mode="link"]');
  assert.equal(api.calls("POST", /manager-memberships$/).length, 1);
  assert.equal(
    api.calls("POST", /manager-grants$/)[1].body.membershipId,
    "m40",
  );
});

test("each enrollment error shows one generic notice and keeps the access tab usable", async () => {
  const { api } = await openAccessInApp(ACCESS, { data: accessData() });
  const link = '[data-issue-manager-grant="m3"][data-delivery-mode="link"]';
  const failed = t("admin.toast.requestFailed");
  const notices = () =>
    $$("[data-operation-error]").filter(
      (notice) => notice.textContent.trim() === failed,
    ).length;
  const codes = [
    ["provider_manager_grant_already_active", "admin.enrollment.alreadyActive"],
    ["manager_grant_conflict", "admin.enrollment.conflict"],
    ["unexpected", ""],
  ];
  for (const [index, [code, key]] of codes.entries()) {
    api.fail("POST", /manager-grants$/, 409, code);
    const before = notices();
    await click(link);
    assert.equal(notices(), before + 1, code);
    // Pins a bug: issueManagerGrant in pages/site/manager.actions.js maps these
    // codes to their own message, but adminErrorMessage ignores it for an HTTP
    // error. No issue filed yet.
    if (key) assert.ok(!pageText().includes(t(key)), code);
    assert.equal(api.calls("POST", /manager-grants$/).length, index + 1);
    assert.equal($(link).disabled, false);
  }
});

test("a Site stays on screen when the session ends", async () => {
  await mountAdmin("/sites/s1");
  vi.stubGlobal("GOOD_NEIGHBOR_ADMIN_CONFIG", {
    .../** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG,
    localDebugAdmin: false,
  });
  $("admin-app").render();
  assert.ok(!missing("#sign-in"));
  assert.equal(heading(), "Example Site");
});

test("saves opened from the directory update the directory's copy", async () => {
  const { api } = await mountAdmin("/sites");
  await click('admin-app a[href="/sites/s1"]');
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await click("[data-save-site-details]");
  assert.equal(heading(), "Example Site Renamed");
  await click('a[href="/sites/s1?section=oversight"]');
  await fill('wa-select[name="managing-system-of-care"]', "BHS-PBH");
  await click("#site-oversight-form [data-save-button]");
  assert.equal(api.calls("PATCH", /^sites\/s1$/).length, 2);
  await click(brandLink);
  assert.match(
    $('admin-app a[href="/sites/s1"]').textContent,
    /Example Site Renamed/,
  );
});

test("an edited setting guards leaving the tab", async () => {
  await mountAdmin("/sites/s1?section=settings");
  await fill(setting311, "false");
  await click('nav[aria-label="Site sections"] a[href$="section=details"]');
  assert.equal($("#site-unsaved-dialog").open, true);
  await click('#site-unsaved-dialog button[value="keep"]');
  assert.equal(window.location.search, "?section=settings");
  assert.equal($(setting311).value, "false");
});

test("a Site ID with a slash stays one path segment on the way back", async () => {
  const data = managerData();
  data.sites.push({
    siteId: "origin/site",
    name: "Slash Site",
    providerId: "v1",
    leadProgramId: "p1",
    status: "active",
  });
  const { api } = await openManagerInApp(
    "/managers/u3?returnSite=origin%2Fsite",
    {
      data,
    },
  );
  await fill(
    '#site-manager-record-form wa-input[name="manager-last-name"]',
    "Persona",
  );
  await click("#site-manager-record-form [data-save-button]");
  assert.equal(
    window.location.pathname + window.location.search,
    "/sites/origin%2Fsite?section=details",
  );
  // Pins a bug: the router keeps the ID encoded and getSite encodes it again,
  // so the Site reads as not found. No issue filed yet.
  assert.deepEqual(
    api.calls("GET", /^sites\/[^/?]*origin/).map((request) => request.path),
    ["sites/origin%252Fsite"],
  );
  assert.match(pageError(), /^not_found/);
});

describe("a compliance period form kept through My profile", () => {
  // A fixed date, so fixture dates such as the 2026-12-31 terms expiry stay in the future.
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-10-15T12:00:00Z") });
  });

  const dialog = "#new-checks-period-dialog";
  const save = `${dialog} [data-save-button]`;
  const saveError = `${dialog} [data-form-save-error]`;
  const reason = (/** @type {string} */ value) =>
    `wa-checkbox[name='terms-reason'][value='${value}']`;
  /** @param {any} site */
  const meta = (site) => ({ ...site, sk: "#META" });

  /** @param {any} data @param {(api: any) => void} [setup] */
  const openComplianceInApp = (data, setup) =>
    mountAdmin(compliancePath, { data, setup });

  async function refuseForMissingContact() {
    await click("[data-require-checks]");
    await fill(reason("1"), true);
    await fill("wa-input[name='terms-expiry']", "2026-12-31");
    await fill("wa-number-input[name='terms-checks-per-day']", "4");
    await click(save);
  }

  test("completing the profile returns to the requirement with its draft", async () => {
    const data = complianceData();
    data.profile = { ...data.profile, phone: "" };
    await openComplianceInApp(data, (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await refuseForMissingContact();
    await click(`${saveError} a`);
    assert.ok(!missing("#my-profile-form"));
    await fill("#my-profile-form wa-input[name='phone']", "4155550123");
    await click("#my-profile-form [data-save-button]");
    await tick(16);
    assert.match(url(), /section=compliance/);
    assert.equal($(dialog).open, true);
    assert.equal($(reason("1")).checked, true);
    assert.equal($("wa-input[name='terms-expiry']").value, "2026-12-31");
    assert.equal($("wa-number-input[name='terms-checks-per-day']").value, "4");
  });

  test("a failed return keeps the draft until the retry succeeds", async () => {
    const data = complianceData();
    const { api } = await openComplianceInApp(data, (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await refuseForMissingContact();
    await click(`${saveError} a`);
    assert.ok(!missing("#profile-title"));
    api.fail("GET", /^sites\/s1\?view=compliance$/, 503, "site_unavailable");
    await routeTo(compliancePath);
    assert.equal(
      $("#retry-compliance-draft").textContent.trim(),
      t("admin.compliance.resumeDraft"),
    );
    api.on("GET", /^sites\/s1\?view=compliance$/, () => ({
      json: {
        items: [meta(data.sites[0]), ...data.siteItems.s1],
        permissions: { canEdit: true },
      },
    }));
    await click("#retry-compliance-draft");
    await tick(16);
    assert.equal($(dialog).open, true);
    assert.equal($(reason("1")).checked, true);
  });

  test("leaving the profile for another page drops the draft", async () => {
    await openComplianceInApp(complianceData(), (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await refuseForMissingContact();
    await click(`${saveError} a`);
    await routeTo("/sites");
    await routeTo(compliancePath);
    await tick(16);
    assert.ok(!missing("#compliance-title"));
    assert.equal($(dialog).open, false);
  });
});
