import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  adminData,
  brandLink,
  click,
  fill,
  missing,
  routeTo,
  text,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";

// The Site directory shows adminCatalog's lists, so a save that skips adminCatalog leaves it stale.
// directoryReads() proves the directory didn't just read the providers list again.

/** @param {string} siteId */
const row = (siteId) => text(`admin-app a[href="/sites/${siteId}"]`);

/** @param {any} api */
const directoryReads = (api) => api.calls("GET", /^providers(\?|$)/).length;

/**
 * Loads the directory first, as for a user arriving from it.
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
async function fromDirectory(options) {
  const mounted = await mountAdmin("/sites", options);
  await click('admin-app a[href="/sites/s1"]');
  return { ...mounted, reads: directoryReads(mounted.api) };
}

test("a Site renamed on its page shows its new name in the directory", async () => {
  const { api, reads } = await fromDirectory();
  await fill('wa-input[name="site-name"]', "Harbor House");
  await click("[data-save-site-details]");
  await click(brandLink);
  assert.match(row("s1"), /Harbor House/);
  assert.equal(directoryReads(api), reads);
});

test("opening a Site renamed elsewhere shows the new name in the directory", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  api.data.sites[0].name = "Renamed Elsewhere";
  await click('admin-app a[href="/sites/s1"]');
  await click(brandLink);
  assert.match(row("s1"), /Renamed Elsewhere/);
  assert.equal(directoryReads(api), reads);
});

test("a manager first seen on a Site's page shows on its directory row", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  assert.doesNotMatch(row("s1"), /Blair Sample/);
  api.data.siteItems.s1.push({
    sk: "MANAGER_MEMBERSHIP#mm9",
    type: "managerMembership",
    membershipId: "mm9",
    personId: "u9",
    name: "Blair Sample",
    status: "active",
  });
  await click('admin-app a[href="/sites/s1"]');
  await click(brandLink);
  assert.match(row("s1"), /Blair Sample/);
  assert.equal(directoryReads(api), reads);
});

test("a new system of care saved on a Site is offered in the directory filter", async () => {
  const { api, reads } = await fromDirectory();
  await click('a[href="/sites/s1?section=oversight"]');
  await fill('wa-select[name="managing-system-of-care"]', "BHS-PBH");
  await click("#site-oversight-form [data-save-button]");
  await click(brandLink);
  assert.ok(!missing('wa-select[name="system"] wa-option[value="BHS-PBH"]'));
  assert.equal(directoryReads(api), reads);
});

test("turning off 311 delivery on a Site's page unchecks it in the directory", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  assert.equal($('[data-site-311="s1"]').checked, true);
  await routeTo("/sites/s1?section=settings");
  await fill(
    '#site-deliberate-311-form wa-select[name="deliberate-311-enabled"]',
    "false",
  );
  await click("#site-deliberate-311-form [data-save-button]");
  await click(brandLink);
  assert.equal($('[data-site-311="s1"]').checked, false);
  assert.equal(directoryReads(api), reads);
});

test("a 311 batch save keeps the saved choice when the directory redraws", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  await fill('[data-site-311="s1"]', false);
  await click("[data-save-311]");
  await routeTo("/sites?q=Example");
  await routeTo("/sites");
  assert.equal($('[data-site-311="s1"]').checked, false);
  assert.equal(directoryReads(api), reads);
});

test("a Site moved to another Program shows that Program in the directory", async () => {
  const data = adminData();
  data.programs.push({
    programId: "p3",
    name: "Other Program",
    providerId: "v1",
    status: "active",
  });
  const { api, reads } = await fromDirectory({
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
  await click(brandLink);
  assert.match(row("s1"), /Other Program/);
  assert.equal(directoryReads(api), reads);
});

test("a deactivated Site leaves the directory", async () => {
  const { api, reads } = await fromDirectory({
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
  assert.ok(missing('admin-app a[href="/sites/s1"]'));
  assert.equal(directoryReads(api), reads);
});

test("a new Site shows in the directory", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  await routeTo("/sites/new?providerId=v1&programId=p1");
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
  await click(brandLink);
  assert.match(row("v1-new-example-site"), /New Example Site/);
  assert.equal(directoryReads(api), reads);
});

test("a renamed provider shows its new name on its Sites' directory rows", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  await routeTo("/providers/v1");
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Renamed Provider",
  );
  await click("#provider-details-form [data-save-button]");
  await click(brandLink);
  assert.match(row("s1"), /Renamed Provider/);
  assert.equal(directoryReads(api), reads);
});

test("a renamed Program shows its new name on its Sites' directory rows", async () => {
  const { api } = await mountAdmin("/sites");
  const reads = directoryReads(api);
  await routeTo("/programs/p1");
  await fill('#program-details-form wa-input[name="program-name"]', "Renamed");
  await click("#program-details-form [data-save-button]");
  await click(brandLink);
  assert.match(row("s1"), /Renamed/);
  assert.equal(directoryReads(api), reads);
});

test("a Program created from a Site's lead Program list is found by search", async () => {
  const { api, reads } = await fromDirectory();
  await fill('wa-select[name="lead-program-id"]', "__create_program__");
  await fill(
    '#create-site-program-dialog wa-input[name="program-name"]',
    "Harbor Outreach",
  );
  await click('#create-site-program-dialog button[type="submit"]');
  await routeTo("/sites?q=Harbor");
  await click('#site-unsaved-dialog button[value="discard"]');
  assert.match($("#directory-results").textContent, /Harbor Outreach/);
  assert.equal(directoryReads(api), reads);
});

test("a compliance manager's new name shows in the directory search", async () => {
  const { api } = await mountAdmin("/sites", { role: "compliance-manager" });
  const reads = directoryReads(api);
  await routeTo("/profile");
  await fill('#my-profile-form wa-input[name="firstName"]', "Robin");
  await click("#my-profile-form [data-save-button]");
  await routeTo("/sites?q=Robin");
  assert.match($("#directory-results").textContent, /Example Site/);
  assert.equal(directoryReads(api), reads);
});
