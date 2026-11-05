import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  missing,
  mountPage,
  routeTo,
  settle,
  submit,
  toastCount,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { adminCatalog } from "./admin-catalog.js";
import "./pages/site/new-site-page.js";

// pages/site/save-error-messages.js has no catalog key for this copy, so tests match its English.

const NEW_RECORD = "/sites/new?providerId=v1&programId=p1";
const created = {
  siteId: "s9",
  name: "New Example Site",
  providerId: "v1",
  leadProgramId: "p1",
  status: "active",
  addressParts: { streetNumber: "200", streetAddress: "Example Ave" },
  publicContact: { email: "desk@example.org", phone: "4155550110" },
};
const url = () => window.location.pathname + window.location.search;
const form = "#new-site-record-form";

async function fillRecord() {
  await fill(`${form} wa-input[name="site-name"]`, created.name);
  await fill(`${form} wa-select[name="site-type"]`, "shelter");
  await click(`${form} [data-enter-address-manually]`);
  for (const [name, value] of [
    ["street-address", "200 Example Ave"],
    ["city", "San Francisco"],
    ["state", "CA"],
    ["zip", "94103"],
  ])
    await fill(`${form} wa-input[name="${name}"]`, value);
  await fill(
    `${form} wa-input[name="public-contact-email"]`,
    "desk@example.org",
  );
  await fill(`${form} wa-input[name="public-contact-phone"]`, "4155550110");
}

/**
 * <admin-new-site-page> alone, without <admin-app>, following the new Site steps; a request
 * other than its create calls fails the test.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openNewSitePage = (path, options = {}) =>
  mountPage("admin-new-site-page", path, {
    follow: ["site-new"],
    calls: [
      /^POST providers\/v1\/sites$/,
      /^PATCH sites\/[^/]+$/,
      /^(GET|POST) sites\/[^/]+\/manager-memberships$/,
      /^POST sites\/[^/]+\/users$/,
    ],
    ...options,
  });

/** @param {any} api @param {any} site */
function serveCreatedSite(api, site) {
  api.on("POST", /^providers\/v1\/sites$/, () => {
    api.data.sites.push({ ...created });
    return { json: { site } };
  });
}

test("the address search clears its empty marker after manual entry opens", async () => {
  await openNewSitePage(NEW_RECORD);
  const search = `${form} [data-address-query]`;
  assert.ok($(search).hasAttribute("data-empty"));
  await click(`${form} [data-enter-address-manually]`);
  await fill(search, "200 Example Ave");
  assert.ok(!$(search).hasAttribute("data-empty"));
});

test("a Site created without create rights still sends its lead Program", async () => {
  const { api } = await openNewSitePage(NEW_RECORD, {
    role: "compliance-manager",
  });
  await fillRecord();
  await submit(form);
  assert.equal(
    api.calls("POST", /^providers\/v1\/sites$/)[0].body.leadProgramId,
    "p1",
  );
});

test("the provider and program steps lead to the Site record", async () => {
  const { api, catalog, page } = await openNewSitePage("/sites/new", {
    setup: (api) =>
      api.data.programUsers.p1.push({
        userId: "u3",
        firstName: "Gone",
        lastName: "Staff",
        status: "inactive",
      }),
  });
  // A providers reply can list an inactive provider; the step must still hide it.
  catalog.setProviders(api.data.providers);
  page.render();
  assert.ok(!missing('#new-site-provider-form wa-option[value="v1"]'));
  assert.ok(missing('#new-site-provider-form wa-option[value="v2"]'));
  await submit("#new-site-provider-form");
  assert.equal(url(), "/sites/new");
  await fill('#new-site-provider-form wa-select[name="provider-id"]', "v1");
  await click('#new-site-provider-form button[type="submit"]');
  assert.match(url(), /providerId=v1$/);
  await fill('#new-site-program-form wa-select[name="program-id"]', "p1");
  await click('#new-site-program-form button[type="submit"]');
  assert.match(url(), /providerId=v1&programId=p1/);
  // Managers are assigned from the Site record once it exists.
  assert.ok(missing(`${form} [name="site-manager-user-id"]`));
  assert.match(
    $(form).textContent,
    new RegExp(t("admin.sites.assignManagerLater")),
  );
});

test("someone who can't create records sees no create links in the new Site flow", async () => {
  await openNewSitePage("/sites/new?providerId=v1", {
    role: "compliance-manager",
  });
  assert.ok(!missing("#new-site-program-form"));
  assert.ok(missing('admin-new-site-page a[href="/sites/new"]'));
  assert.ok(missing('admin-new-site-page a[href^="/programs/new"]'));
});

test("a provider without programs cannot continue", async () => {
  await openNewSitePage("/sites/new?providerId=v3", {
    setup: (api) =>
      api.data.providers.push({
        providerId: "v3",
        name: "Empty Provider",
        status: "active",
      }),
  });
  assert.equal(
    $('#new-site-program-form button[type="submit"]').disabled,
    true,
  );
});

test("a program without staff can still create a Site", async () => {
  await openNewSitePage(NEW_RECORD, {
    setup: (api) => {
      api.data.programUsers.p1 = [];
    },
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/v1-new-example-site");
});

test("creating a Site without a manager opens the new record", async () => {
  const { api } = await openNewSitePage(NEW_RECORD);
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/v1-new-example-site");
  // The create reply is enough; a full directory reload costs every create a round trip.
  assert.deepEqual(api.calls("GET", /^programs$/), []);
  const { body } = api.calls("POST", /^providers\/v1\/sites$/)[0];
  assert.deepEqual(
    [body.name, body.leadProgramId, body.siteType],
    [created.name, "p1", "shelter"],
  );
  assert.equal("primaryContactUserId" in body, false);
  assert.deepEqual(
    [body.addressParts.streetNumber, body.addressParts.streetAddress],
    ["200", "Example Ave"],
  );
  assert.equal(api.calls("POST", /manager-memberships$/).length, 0);
  assert.equal(api.calls("PATCH", /^sites\//).length, 0);
});

test("a partly saved Site is repaired before it opens", async () => {
  const { api } = await openNewSitePage(NEW_RECORD, {
    setup: (api) => {
      serveCreatedSite(api, { siteId: "s9", name: created.name });
      api.on("PATCH", /^sites\/s9$/, { json: { site: created } });
      api.on("GET", /^sites\/s9\/manager-memberships$/, { json: {} });
    },
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/s9");
  assert.equal(api.calls("POST", /^sites\/s9\/users$/).length, 0);
  const patch = api.calls("PATCH", /^sites\/s9$/)[0].body;
  assert.equal("primaryContactUserId" in patch, false);
  assert.deepEqual(patch.addressParts, {
    streetNumber: "200",
    streetAddress: "Example Ave",
    secondLine: "",
    city: "San Francisco",
    state: "CA",
    zip: "94103",
  });
  assert.deepEqual(
    [patch.publicContact.email, patch.publicContact.phone],
    ["desk@example.org", "4155550110"],
  );
  assert.equal(api.calls("POST", /^sites\/s9\/manager-memberships$/).length, 0);
});

for (const [label, setup, message] of [
  [
    "the repair cannot complete",
    (/** @type {any} */ api) => {
      serveCreatedSite(api, { ...created, publicContact: undefined });
      api.on("PATCH", /^sites\/s9$/, {
        json: { site: { ...created, primaryContactUserId: "u2" } },
      });
    },
    "The Site was created, but its address, manager, or public contact was not fully saved. Reopen the Site and complete the missing fields.",
  ],
  [
    "the API rejects it",
    (/** @type {any} */ api) =>
      api.fail("POST", /^providers\/v1\/sites$/, 409, "site_already_exists"),
    t("admin.errors.siteExists"),
  ],
])
  test(`a Site keeps the form with an error when ${label}`, async () => {
    await openNewSitePage(NEW_RECORD, { setup: /** @type {any} */ (setup) });
    await fillRecord();
    await click(`${form} button[type="submit"]`);
    assert.equal(
      $(`${form} [data-form-save-error]`).textContent.trim(),
      message,
    );
    assert.match(url(), /programId=p1/);
  });

test("a Site saved after the user left does not pull them back", async () => {
  const held = gate();
  const { api } = await openNewSitePage(NEW_RECORD, {
    setup: (api) =>
      api.on("POST", /^providers\/v1\/sites$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(api.calls("POST", /^providers\/v1\/sites$/).length, 1);
  await routeTo("/providers");
  held.release();
  await settle();
  assert.equal(url(), "/providers");
});

test("a Site save that finishes after leave() doesn't navigate, even at the same address", async () => {
  const held = gate();
  const { page } = await openNewSitePage(NEW_RECORD, {
    setup: (api) =>
      api.on("POST", /^providers\/v1\/sites$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  await settle();
  assert.equal(url(), NEW_RECORD);
});

test("a new Site whose ID has a slash opens at one encoded path segment", async () => {
  const site = { ...created, siteId: "s/9" };
  await openNewSitePage(NEW_RECORD, {
    setup: (api) =>
      api.on("POST", /^providers\/v1\/sites$/, () => {
        api.data.sites.push({ ...site });
        return { json: { site } };
      }),
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/s%2F9");
});

/** Hold the Site create, leave for Providers, then reject it. @param {number} status @param {string} code */
async function rejectAfterLeaving(status, code) {
  const held = gate();
  await openNewSitePage(NEW_RECORD, {
    setup: (api) =>
      api.on("POST", /^providers\/v1\/sites$/, async () => {
        await held.promise;
        return { status, json: { error: code } };
      }),
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  await routeTo("/providers");
  held.release();
  await settle();
}

test("a Site save rejected after leaving explains the error in one toast", async () => {
  const message =
    "Enter a valid public contact email and 10-digit phone number.";
  await rejectAfterLeaving(400, "invalid_public_contact");
  assert.equal(toastCount(message), 1);
});

test("a duplicate Site rejected after leaving is titled as a duplicate", async () => {
  await rejectAfterLeaving(409, "site_already_exists");
  assert.equal(toastCount(t("admin.errors.siteExistsTitle")), 1);
});

test("the mounted new Site page adds the Site to its own catalog, not adminCatalog", async () => {
  const { catalog } = await openNewSitePage(NEW_RECORD, {
    setup: (api) => {
      serveCreatedSite(api, created);
      api.on("GET", /^sites\/s9\/manager-memberships$/, { json: {} });
    },
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.ok(catalog.sites.some((site) => site.siteId === "s9"));
  assert.deepEqual(adminCatalog.sites, []);
});

test("a redraw after the URL moves on still draws the route open() was given", async () => {
  const { page } = await openNewSitePage("/sites/new");
  window.history.replaceState({}, "", "/not-a-page");
  page.render();
  assert.ok(!missing("admin-new-site-page h1"));
});
