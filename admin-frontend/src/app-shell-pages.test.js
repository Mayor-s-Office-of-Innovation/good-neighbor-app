import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  adminData,
  alertText,
  brandLink,
  byText,
  click,
  fill,
  missing,
  pageError,
  routeTo,
  settle,
  submit,
  toastText,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// What <admin-app> does around its pages: the leave prompt, and errors and reloads
// after the user leaves. mountPage() tests each page alone.

const url = () => window.location.pathname + window.location.search;
const pastImports = () => $('[aria-labelledby="past-imports-title"]');
const ACCESS = "/providers/v1?section=access";
const grants = /^providers\/v1\/manager-grants$/;
/** @param {string} mode */
const issueButton = (mode) =>
  `[data-issue-provider-manager-grant='m1'][data-delivery-mode='${mode}']`;
const title = () => $("#provider-title").textContent.trim();
const NEW_RECORD = "/sites/new?providerId=v1&programId=p1";
const form = "#new-site-record-form";
const plainUser = {
  username: "plain1",
  name: "Gale Plain",
  email: "gale@example.org",
  role: "compliance-manager",
  status: "CONFIRMED",
};

/**
 * @param {string} path
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
const openProviders = (path, options = {}) =>
  mountAdmin(path, { data: providerData(), ...options });

/** @param {Parameters<typeof mountAdmin>[1]["setup"]} setup */
const openImport = (setup, path = "/sites/import") =>
  mountAdmin(path, { setup });

function openUsers() {
  const data = adminData();
  data.adminUsers = [{ ...plainUser }];
  return mountAdmin("/administrators", {
    data,
    setup: (api) =>
      api.on("GET", /^admin-users$/, () => ({
        json: { users: api.data.adminUsers, directoryMode: "local" },
      })),
  });
}

/** @param {string} username */
const actionButton = (action, username) =>
  $(`[data-admin-user-action="${action}"][data-username="${username}"]`);

async function fillInvite() {
  await fill('#admin-user-form wa-input[name="firstName"]', "Ivy");
  await fill('#admin-user-form wa-input[name="lastName"]', "Invitee");
  await fill('#admin-user-form wa-input[name="email"]', "ivy@example.org");
  await fill('#admin-user-form wa-input[name="phone"]', "4155550120");
  await fill('#admin-user-form wa-select[name="departmentId"]', "d1");
}

const profileField = (/** @type {string} */ name) =>
  `#my-profile-form wa-input[name="${name}"]`;

async function fillRecord() {
  await fill(`${form} wa-input[name="site-name"]`, "New Example Site");
  await fill(`${form} wa-select[name="site-type"]`, "shelter");
  await click(`${form} [data-enter-address-manually]`);
  for (const [name, value] of [
    ["street-address", "200 Example Ave"],
    ["city", "San Francisco"],
    ["state", "CA"],
    ["zip", "94103"],
    ["public-contact-email", "desk@example.org"],
    ["public-contact-phone", "4155550110"],
  ])
    await fill(`${form} wa-input[name="${name}"]`, value);
}

test("an unsaved provider rename asks before leaving", async () => {
  await openProviders("/providers/v1");
  const name = "#provider-details-form wa-input[name='provider-name']";
  await fill(name, "Unsaved Name");
  await click(brandLink);
  assert.equal($("#site-unsaved-dialog").open, true);
  await click("#site-unsaved-dialog button[value='keep']");
  assert.equal(url(), "/providers/v1");
  // Resetting the form clears the dirty flag, so leaving no longer asks.
  $("#provider-details-form").reset();
  await settle();
  assert.equal($("#provider-details-form [data-save-button]").disabled, true);
  await click(brandLink);
  assert.equal(url(), "/sites");
  assert.ok(missing("#site-unsaved-dialog[open]"));
  await routeTo("/providers/v1");
  await fill(name, "Unsaved Again");
  await click(brandLink);
  await click("#site-unsaved-dialog button[value='discard']");
  assert.equal(url(), "/sites");
});

test("an already-active reply after leaving the provider is not drawn", async () => {
  const held = gate();
  const { api } = await openProviders(ACCESS, {
    setup: (api) =>
      api.on("POST", grants, {
        delay: held.promise,
        status: 409,
        json: { error: "provider_manager_grant_already_active" },
      }),
  });
  await click(issueButton("link"));
  assert.equal(api.calls("POST", grants).length, 1);
  await routeTo("/providers/v2?section=access");
  assert.equal(title(), "Second Provider");
  held.release();
  await settle();
  assert.ok(!missing("[data-operation-error]"));
  assert.ok(missing("[data-provider-manager-grant-error]"));
});

test("a user action that ends after the user leaves doesn't reload the page they're on", async () => {
  const held = gate();
  const { api } = await openUsers();
  api.on("POST", /^admin-users\/plain1\/suspend$/, {
    delay: held.promise,
    json: { user: { ...plainUser, enabled: false } },
  });
  await click(actionButton("suspend", "plain1"));
  await routeTo("/sites/import");
  const reads = api.calls("GET", /^site-imports$/).length;
  held.release();
  await settle();
  // A reload there would redraw the page and drop any unsaved edit on it.
  assert.ok(!missing("#upload-title"));
  assert.equal(api.calls("GET", /^site-imports$/).length, reads);
});

test("an invite makes the Site the user returns to reread program managers", async () => {
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^admin-users$/, (request) => ({
        json: {
          user: { username: "ivy", email: request.body.email },
          invitationStatus: "invited",
        },
      })),
  });
  await routeTo("/administrators/new");
  await fillInvite();
  await submit("#admin-user-form");
  // A new account may be a program manager, so the Site's cached list is stale.
  const managerReads = api.calls("GET", /^program-managers$/).length;
  await routeTo("/sites/s1");
  assert.equal(api.calls("GET", /^program-managers$/).length, managerReads + 1);
});

test("after an invite, only the first Site visit rereads program managers", async () => {
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^admin-users$/, (request) => ({
        json: {
          user: { username: "ivy", email: request.body.email },
          invitationStatus: "invited",
        },
      })),
  });
  await routeTo("/administrators/new");
  await fillInvite();
  await submit("#admin-user-form");
  await routeTo("/sites/s1");
  const managerReads = api.calls("GET", /^program-managers$/).length;
  await routeTo("/sites/s2");
  await routeTo("/sites/s1");
  assert.equal(api.calls("GET", /^program-managers$/).length, managerReads);
});

test("an invitation still sending blocks leaving, then stays put", async () => {
  const held = gate();
  await mountAdmin("/administrators/new", {
    setup: (api) =>
      api.on("POST", /^admin-users$/, async () => {
        await held.promise;
        return {
          json: {
            user: { username: "ivy", email: "ivy@example.org" },
            invitationStatus: "invited",
          },
        };
      }),
  });
  await fillInvite();
  await submit("#admin-user-form");
  assert.equal($("#admin-user-form").dataset.saving, "true");
  await click(brandLink);
  assert.equal(window.location.pathname, "/administrators/new");
  await routeTo("/providers");
  assert.equal(window.location.pathname, "/administrators/new");
  assert.ok(!missing("#new-admin-user-title"));
  held.release();
  await settle();
  assert.equal(window.location.pathname, "/administrators");
  assert.match(toastText(), new RegExp(t("admin.toast.invitationSent")));
});

test("opening Manage users reads only the session and the user list", async () => {
  const { api } = await openUsers();
  // Supervisors open this page often; it must not wait for the Site, Provider and Program directories.
  assert.deepEqual(api.requests.map((request) => request.path).sort(), [
    "admin-users",
    "session",
  ]);
});

/**
 * Start a profile save held by `held`, then leave the page and discard the edit.
 * @param {{ promise: Promise<void> }} held
 * @param {any} reply
 */
async function leaveDuringProfileSave(held, reply) {
  const { api } = await mountAdmin("/profile", {
    setup: (api) =>
      api.on("PUT", /^profile$/, async () => {
        await held.promise;
        return reply;
      }),
  });
  await fill(profileField("lastName"), "Changed");
  await submit("#my-profile-form");
  return api;
}

test("a profile save is ignored while one is running", async () => {
  const held = gate();
  const api = await leaveDuringProfileSave(held, {
    json: { profile: adminData().profile },
  });
  await submit("#my-profile-form");
  await click(brandLink);
  // The edit is still unsaved while the save runs, so leaving asks first.
  await click('#site-unsaved-dialog button[value="discard"]');
  assert.ok(!missing("#directory-title"));
  // Mark the directory; a redraw from the late reply replaces it and drops the mark.
  $("#directory-title").setAttribute("data-probe", "kept");
  held.release();
  await settle();
  assert.ok(!missing("#directory-title[data-probe='kept']"));
  assert.equal(api.calls("PUT", /^profile$/).length, 1);
});

test("a failed profile save after leaving the page shows the request-failed alert", async () => {
  const held = gate();
  await leaveDuringProfileSave(held, {
    status: 500,
    json: { error: "server_error" },
  });
  await click(brandLink);
  await click('#site-unsaved-dialog button[value="discard"]');
  held.release();
  await settle();
  assert.ok(!missing("#directory-title"));
  // Pins a bug: a save the user left still alerts on the page they moved to.
  assert.ok(alertText().includes(t("admin.toast.requestFailed")));
});

test("an unreadable import link shows the error and a retry", async () => {
  await openImport((api) => {
    api.on("GET", /^site-imports\/i3$/, {
      json: { import: { status: "previewed", previewVersion: 1 }, rows: [] },
    });
    api.on("GET", /^site-imports\/i3$/, failTimes(1, 404, "import_not_found"));
  }, "/sites/import?importId=i3");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "import_not_found");
  await click("#retry-page-load");
  assert.ok(!missing("#review-title"));
  assert.equal(pageError(), "");
});

test("a Compliance manager reaches the upload form by URL though the menu hides Import", async () => {
  const { api } = await mountAdmin("/sites/import", {
    role: "compliance-manager",
    setup: (api) => (api.data.imports = [{ fileName: "old.csv" }]),
  });
  assert.ok(missing('a[href="/sites/import"]'));
  // Pins a gap: the import route has no capability check, so the upload form
  // shows to a Compliance manager. No issue filed yet.
  assert.ok(!missing("#upload-title"));
  // The backend refuses their history read with a 403, and the table reads as empty, with no error.
  assert.equal(api.calls("GET", /^site-imports$/).length, 1);
  assert.match(pastImports().textContent, /No past imports\./);
  assert.doesNotMatch(pastImports().textContent, /old\.csv/);
  assert.equal(pageError(), "");
  assert.equal(toastText(), "");
});

test("a new Site makes the next manager directory load start over", async () => {
  const held = gate();
  const { api } = await mountAdmin("/managers", {
    setup: (api) =>
      api.on("GET", /^people$/, async (/** @type {any} */ request) => {
        if (api.calls("GET", /^people$/).length === 1) await held.promise;
        return api.reply(request);
      }),
  });
  await routeTo(NEW_RECORD);
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/v1-new-example-site");
  const reads = api.calls("GET", /^people$/).length;
  await routeTo("/managers");
  // The held load predates the Site, so the directory fetches again without waiting for it.
  assert.equal(api.calls("GET", /^people$/).length, reads + 1);
  held.release();
  await settle();
});

test("creating a Site opens its record in <admin-app>", async () => {
  await mountAdmin("/sites");
  await routeTo(NEW_RECORD);
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/v1-new-example-site");
  assert.equal($("admin-app h1").textContent.trim(), "New Example Site");
});

test("a typed invite asks before leaving", async () => {
  await mountAdmin("/administrators/new");
  await fill('#admin-user-form wa-input[name="firstName"]', "Ivy");
  await click(brandLink);
  assert.equal($("#site-unsaved-dialog").open, true);
  await click("#site-unsaved-dialog button[value='keep']");
  assert.equal(url(), "/administrators/new");
  assert.equal($('#admin-user-form wa-input[name="firstName"]').value, "Ivy");
});

test("a past import's history link opens its results", async () => {
  await openImport((api) => {
    api.data.imports = [
      {
        importId: "i 4",
        fileName: "done.csv",
        status: "complete",
        outcomes: { applied: 1 },
      },
    ];
  });
  await click(byText("done.csv", "a"));
  assert.equal(url(), "/sites/import?importId=i%204");
  assert.ok(
    $('[aria-labelledby="import-results-title"]').textContent.includes(
      t("admin.import.outcomeCounts", { applied: 1, failed: 0 }),
    ),
  );
});

test("a Supervisor deactivates a Site after typing its name", async () => {
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) => {
      // A Site that stays listed, so an empty directory can't pass the check below.
      api.data.sites.push({
        ...api.data.sites[0],
        siteId: "s9",
        name: "Control Site",
      });
      api.data.providers[0].sites.push({
        siteId: "s9",
        siteName: "Control Site",
        status: "active",
      });
      api.on("DELETE", /^sites\/s1$/, () => {
        const site = api.data.sites.find(
          (/** @type {any} */ item) => item.siteId === "s1",
        );
        Object.assign(site, { status: "inactive" });
        return { json: { site: { ...site } } };
      });
    },
  });
  const button = () => $('#deactivate-site-form button[type="submit"]');
  const confirmation = '#deactivate-site-form wa-input[name="confirmation"]';
  assert.equal(button().disabled, true);
  await fill(confirmation, "Wrong");
  assert.equal(button().disabled, true);
  await submit("#deactivate-site-form");
  assert.equal(api.calls("DELETE", /^sites\/s1$/).length, 0);
  await fill(confirmation, "Example Site");
  assert.equal(button().disabled, false);
  await click(button());
  assert.equal(url(), "/sites");
  assert.equal(api.calls("DELETE", /^sites\/s1$/).length, 1);
  assert.equal(pageError(), "");
  assert.ok(!missing('[aria-labelledby="sites-title"] a[href="/sites/s9"]'));
  assert.ok(missing('[aria-labelledby="sites-title"] a[href="/sites/s1"]'));
});

test("a failed deactivation stays on the Site with an error", async () => {
  await mountAdmin("/sites/s1", {
    setup: (api) => api.fail("DELETE", /^sites\/s1$/),
  });
  await fill(
    '#deactivate-site-form wa-input[name="confirmation"]',
    "Example Site",
  );
  await click('#deactivate-site-form button[type="submit"]');
  assert.equal(
    $("#deactivate-site-form [data-form-save-error]").textContent.trim(),
    t("admin.site.deactivateError"),
  );
  assert.equal(url(), "/sites/s1");
});

test("a provider deactivation that fails after the user leaves still shows why", async () => {
  const held = gate();
  await openProviders("/providers/v1", {
    setup: (api) =>
      api.on("DELETE", /^providers\/v1$/, {
        delay: held.promise,
        status: 409,
        json: { error: "provider_has_sites", message: "provider_has_sites" },
      }),
  });
  await click("[data-deactivate-provider='v1']");
  await click("#deactivate-provider-dialog button[value='confirm']");
  await routeTo("/sites");
  held.release();
  await settle();
  assert.ok(!missing("#directory-title"));
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "provider_has_sites");
});

test("signing out drops a page's unsaved 311 edits with the session", async () => {
  vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const { app } = await mountAdmin("/sites");
  await fill('[data-site-311="s1"]', false);
  assert.equal(app.hasUnsavedSiteChanges(), true);
  await click("#clear-token");
  assert.equal(app.hasUnsavedSiteChanges(), false);
});

test("a page clearing an error line that is already clear doesn't redraw <admin-app>", async () => {
  const { app } = await mountAdmin("/sites/import");
  const render = vi.spyOn(app, "render");
  $("admin-site-import-page").reportError(new Error(""));
  assert.equal(render.mock.calls.length, 0);
});
