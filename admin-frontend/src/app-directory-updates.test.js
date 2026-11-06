import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  adminData,
  click,
  fill,
  missing,
  mountPage,
  routeTo,
  text,
  window,
} from "../test-support/admin-dom.js";
import { openSitePage } from "../test-support/site-pages.js";
import "./pages/admin-user/admin-users-page.js";
import "./pages/directory/directory-page.js";
import "./pages/program/program-page.js";
import "./pages/provider/provider-page.js";
import "./pages/site/new-site-page.js";

// Each page here shares one catalog, as under <admin-app>, so a save that skips the
// catalog leaves the directory stale. directoryReads() proves it didn't read Sites again.

/** @typedef {Partial<Parameters<typeof mountPage>[2]>} PageOptions */

/** @param {string} siteId */
const row = (siteId) => text(`admin-directory-page a[href="/sites/${siteId}"]`);

/** @param {any} api */
const directoryReads = (api) => api.calls("GET", /^providers(\?|$)/).length;

/**
 * The directory, with its Sites read once; later mounts pass its catalog back in.
 * @param {string} [path]
 * @param {PageOptions} [options]
 */
async function openDirectory(path = "/sites", options = {}) {
  const { api, catalog, session } = await mountPage(
    "admin-directory-page",
    path,
    {
      follow: ["sites"],
      calls: [
        /^PUT sites\/[^/]+\/deliberate-311$/,
        // A search in the URL reads the manager directory, which makes these calls.
        /^GET people$/,
        /^GET programs\/[^/]+$/,
        /^GET sites\/[^/]+\/manager-memberships$/,
        /^GET sites\/[^/]+\?roster=1$/,
      ],
      sites: true,
      ...options,
    },
  );
  return { api, shared: { catalog, session } };
}

/**
 * The directory again after a save on another page, sharing that page's catalog.
 * @param {{ catalog: any, session: any }} shared
 * @param {string} [path]
 */
async function backToDirectory({ catalog, session }, path = "/sites") {
  const { api } = await openDirectory(path, { catalog, session });
  assert.equal(directoryReads(api), 0);
}

test("a Site renamed on its page shows its new name in the directory", async () => {
  const { shared } = await openDirectory();
  await openSitePage("/sites/s1", shared);
  await fill('wa-input[name="site-name"]', "Harbor House");
  await click("[data-save-site-details]");
  await backToDirectory(shared);
  assert.match(row("s1"), /Harbor House/);
});

test("opening a Site renamed elsewhere shows the new name in the directory", async () => {
  const { shared } = await openDirectory();
  const data = adminData();
  data.sites[0].name = "Renamed Elsewhere";
  await openSitePage("/sites/s1", { ...shared, data });
  await backToDirectory(shared);
  assert.match(row("s1"), /Renamed Elsewhere/);
});

test("a manager first seen on a Site's page shows on its directory row", async () => {
  const { shared } = await openDirectory();
  assert.doesNotMatch(row("s1"), /Blair Sample/);
  const data = adminData();
  data.siteItems.s1.push({
    sk: "MANAGER_MEMBERSHIP#mm9",
    type: "managerMembership",
    membershipId: "mm9",
    personId: "u9",
    name: "Blair Sample",
    status: "active",
  });
  await openSitePage("/sites/s1", { ...shared, data });
  await backToDirectory(shared);
  assert.match(row("s1"), /Blair Sample/);
});

test("a new system of care saved on a Site is offered in the directory filter", async () => {
  const { shared } = await openDirectory();
  await openSitePage("/sites/s1?section=oversight", shared);
  await fill('wa-select[name="managing-system-of-care"]', "BHS-PBH");
  await click("#site-oversight-form [data-save-button]");
  await backToDirectory(shared);
  assert.ok(!missing('wa-select[name="system"] wa-option[value="BHS-PBH"]'));
});

test("turning off 311 delivery on a Site's page unchecks it in the directory", async () => {
  const { shared } = await openDirectory();
  assert.equal($('[data-site-311="s1"]').checked, true);
  await openSitePage("/sites/s1?section=settings", shared);
  await fill(
    '#site-deliberate-311-form wa-select[name="deliberate-311-enabled"]',
    "false",
  );
  await click("#site-deliberate-311-form [data-save-button]");
  await backToDirectory(shared);
  assert.equal($('[data-site-311="s1"]').checked, false);
});

test("a 311 batch save keeps the saved choice when the directory redraws", async () => {
  const { api } = await openDirectory();
  await fill('[data-site-311="s1"]', false);
  await click("[data-save-311]");
  await routeTo("/sites?q=Example");
  await routeTo("/sites");
  assert.equal($('[data-site-311="s1"]').checked, false);
  assert.equal(directoryReads(api), 0);
});

test("a Site moved to another Program shows that Program in the directory", async () => {
  const data = adminData();
  data.programs.push({
    programId: "p3",
    name: "Other Program",
    providerId: "v1",
    status: "active",
  });
  const { shared } = await openDirectory("/sites", { data });
  await openSitePage("/sites/s1", {
    ...shared,
    data,
    setup: (api) =>
      api.on("POST", /^sites\/s1\/reassign$/, (request) =>
        request.body.preview
          ? {
              json: {
                preview: {
                  updatedAt: "2026-10-20T10:00:00Z",
                  previousProvider: "Example Provider",
                  newProvider: "Example Provider",
                  previousProgram: "Example Program",
                  newProgram: "Other Program",
                  retainedManagers: [],
                  affectedProviderDevices: 0,
                },
              },
            }
          : { json: { site: { leadProgramId: "p3" } } },
      ),
  });
  await fill('wa-select[name="lead-program-id"]', "p3");
  await click("[data-save-lead-program]");
  await click('#lead-program-confirmation-dialog button[value="confirm"]');
  await backToDirectory(shared);
  assert.match(row("s1"), /Other Program/);
});

test("a deactivated Site leaves the directory", async () => {
  const { shared } = await openDirectory();
  await openSitePage("/sites/s1", {
    ...shared,
    setup: (api) =>
      api.on("DELETE", /^sites\/s1$/, () => {
        Object.assign(api.data.sites[0], { status: "inactive" });
        return { json: { site: { ...api.data.sites[0] } } };
      }),
  });
  await fill(
    '#deactivate-site-form wa-input[name="confirmation"]',
    "Example Site",
  );
  await click('#deactivate-site-form button[type="submit"]');
  assert.equal(window.location.pathname, "/sites");
  await backToDirectory(shared);
  assert.ok(missing('admin-directory-page a[href="/sites/s1"]'));
});

test("a new Site shows in the directory", async () => {
  const { shared } = await openDirectory();
  await mountPage(
    "admin-new-site-page",
    "/sites/new?providerId=v1&programId=p1",
    {
      ...shared,
      calls: [
        /^POST providers\/v1\/sites$/,
        /^PATCH sites\/[^/]+$/,
        /^(GET|POST) sites\/[^/]+\/manager-memberships$/,
        /^POST sites\/[^/]+\/users$/,
      ],
    },
  );
  const form = "#new-site-record-form";
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
  await click(`${form} button[type="submit"]`);
  await backToDirectory(shared);
  assert.match(row("v1-new-example-site"), /New Example Site/);
});

test("a renamed provider shows its new name on its Sites' directory rows", async () => {
  const { shared } = await openDirectory();
  await mountPage("admin-provider-page", "/providers/v1", {
    ...shared,
    calls: [
      /^GET providers\/[^/]+$/,
      /^GET providers\/[^/]+\/(manager-memberships|grants)$/,
      /^GET people$/,
      /^PATCH providers\/[^/]+$/,
    ],
  });
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Renamed Provider",
  );
  await click("#provider-details-form [data-save-button]");
  await backToDirectory(shared);
  assert.match(row("s1"), /Renamed Provider/);
});

test("a renamed Program shows its new name on its Sites' directory rows", async () => {
  const { shared } = await openDirectory();
  await mountPage("admin-program-page", "/programs/p1", {
    ...shared,
    calls: [
      /^GET programs\/[^/]+$/,
      /^GET sites\/[^/?]+\?roster=1$/,
      /^PATCH programs\/[^/]+$/,
    ],
  });
  await fill('#program-details-form wa-input[name="program-name"]', "Renamed");
  await click("#program-details-form [data-save-button]");
  await backToDirectory(shared);
  assert.match(row("s1"), /Renamed/);
});

test("a Program created from a Site's lead Program list is found by search", async () => {
  const { shared } = await openDirectory();
  await openSitePage("/sites/s1", shared);
  await fill('wa-select[name="lead-program-id"]', "__create_program__");
  await fill(
    '#create-site-program-dialog wa-input[name="program-name"]',
    "Harbor Outreach",
  );
  await click('#create-site-program-dialog button[type="submit"]');
  await backToDirectory(shared, "/sites?q=Harbor");
  assert.match($("#directory-results").textContent, /Harbor Outreach/);
});

test("a compliance manager's new name shows in the directory search", async () => {
  const { shared } = await openDirectory("/sites", {
    role: "compliance-manager",
  });
  await mountPage("admin-users-page", "/profile", {
    ...shared,
    role: "compliance-manager",
    calls: [/^(GET|PUT) profile$/, /^GET oversight-options$/],
  });
  await fill('#my-profile-form wa-input[name="firstName"]', "Robin");
  await click("#my-profile-form [data-save-button]");
  await backToDirectory(shared, "/sites?q=Robin");
  assert.match($("#directory-results").textContent, /Example Site/);
});
