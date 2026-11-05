import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  missing,
  mountAdmin,
  pageError,
  routeTo,
  settle,
  submit,
  toastCount,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";

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

/** @param {any} api @param {any} site */
function serveCreatedSite(api, site) {
  api.on("POST", /^providers\/v1\/sites$/, () => {
    api.data.sites.push({ ...created });
    return { json: { site } };
  });
}

test("the provider and program steps lead to the Site record", async () => {
  await mountAdmin("/sites/new", {
    setup: (api) => {
      api.data.programUsers.p1.push({
        userId: "u3",
        firstName: "Gone",
        lastName: "Staff",
        status: "inactive",
      });
      api.on("GET", /^providers(\?|$)/, (request) => ({
        json: { ...api.reply(request).json, providers: api.data.providers },
      }));
    },
  });
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

test("a provider without programs cannot continue", async () => {
  await mountAdmin("/sites/new?providerId=v3", {
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
  const { api } = await mountAdmin(NEW_RECORD, {
    setup: (api) => {
      api.data.programUsers.p1 = [];
    },
  });
  await fillRecord();
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/v1-new-example-site");
});

test("creating a Site without a manager opens the new record", async () => {
  const { api } = await mountAdmin(NEW_RECORD);
  await fillRecord();
  const directoryReads = api.calls("GET", /^programs$/).length;
  await click(`${form} button[type="submit"]`);
  assert.equal(url(), "/sites/v1-new-example-site");
  // The create reply is enough; a full directory reload costs every create a round trip.
  assert.equal(api.calls("GET", /^programs$/).length, directoryReads);
  assert.equal($("admin-app h1").textContent.trim(), created.name);
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

test("a partly saved Site is repaired before it opens", async () => {
  const { api } = await mountAdmin(NEW_RECORD, {
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
    await mountAdmin(NEW_RECORD, { setup: /** @type {any} */ (setup) });
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
  const { api } = await mountAdmin(NEW_RECORD, {
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
  assert.ok(!missing('a[href="/providers/v1"]'));
  held.release();
  await settle();
  assert.equal(url(), "/providers");
});

test("a new Site whose ID has a slash opens at one encoded path segment", async () => {
  const site = { ...created, siteId: "s/9" };
  await mountAdmin(NEW_RECORD, {
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
  await mountAdmin(NEW_RECORD, {
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
