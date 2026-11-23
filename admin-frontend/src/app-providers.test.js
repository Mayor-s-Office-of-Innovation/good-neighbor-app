import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  brandLink,
  click,
  fill,
  pageError,
  pageText,
  routeTo,
  settle,
  submit,
  toastText,
  window,
  missing,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/provider/provider.templates.js and provider.bindings.js have no
// catalog key for this copy, so tests match their English.

/**
 * @param {string} path
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
const openProviders = (path, options = {}) =>
  mountAdmin(path, {
    data: providerData(),
    ...options,
    setup: (api) => {
      // Stored, so the reloaded provider list drops a deactivated provider.
      api.on("DELETE", /^providers\/v1$/, () => {
        const provider = api.data.providers.find(
          (/** @type {any} */ item) => item.providerId === "v1",
        );
        provider.status = "inactive";
        return { json: { provider: { ...provider } } };
      });
      options.setup?.(api);
    },
  });

const title = () =>
  document.querySelector("#provider-title")?.textContent.trim();
const url = () => window.location.pathname + window.location.search;
const programSelect = "#provider-program-form wa-select[name='program-id']";
const addProgram = "#provider-program-form [data-add-program-button]";
const backLink = 'a[data-route]:has(> wa-icon[name="chevron-left"])';

async function deactivate() {
  await click("[data-deactivate-provider='v1']");
  await click("#deactivate-provider-dialog button[value='confirm']");
}

test("a supervisor renames a provider and the Save button tracks edits", async () => {
  const { api } = await openProviders("/providers/v1");
  const save = () => $("#provider-details-form [data-save-button]");
  assert.equal(save().disabled, true);
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Renamed Provider",
  );
  assert.equal(save().disabled, false);
  await click(save());
  assert.equal(title(), "Renamed Provider");
  assert.deepEqual(api.calls("PATCH", /^providers\/v1$/)[0].body, {
    name: "Renamed Provider",
  });
});

test("a failed provider rename shows the error on the page", async () => {
  await openProviders("/providers/v1", {
    setup: (api) =>
      api.fail("PATCH", /^providers\/v1$/, 409, "provider_already_exists"),
  });
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Second Provider",
  );
  await click("#provider-details-form [data-save-button]");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "provider_already_exists");
});

test("a provider adopts an available Program and the list reloads", async () => {
  const data = providerData();
  const { api } = await openProviders("/providers/v1", {
    data,
    setup: (api) =>
      api.on("POST", /^providers\/v1\/programs$/, () => {
        data.programs[2].providerId = "v1";
        return { json: { program: data.programs[2] } };
      }),
  });
  assert.equal($(addProgram).disabled, true);
  await fill(programSelect, "p3");
  assert.equal($(addProgram).disabled, false);
  await click(addProgram);
  assert.ok(!missing('a[data-route][href="/programs/p3"]'));
  assert.deepEqual(api.calls("POST", /^providers\/v1\/programs$/)[0].body, {
    programId: "p3",
  });
  assert.equal($(programSelect).hasAttribute("disabled"), true);
  assert.match(
    pageText(),
    /Every active Program is already linked to this provider\./,
  );
});

test("adding a Program that still has Sites explains the conflict", async () => {
  await openProviders("/providers/v1", {
    setup: (api) =>
      api.fail("POST", /^providers\/v1\/programs$/, 409, "program_has_sites"),
  });
  await fill(programSelect, "p3");
  await click(addProgram);
  assert.match(pageError(), /This Program has active Sites/);
});

test("adding a Program reports other failures as they come", async () => {
  await openProviders("/providers/v1", {
    setup: (api) =>
      api.fail("POST", /^providers\/v1\/programs$/, 500, "program_not_found"),
  });
  await fill(programSelect, "p3");
  await click(addProgram);
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "program_not_found");
});

test("an empty Program choice does not call the API", async () => {
  const { api } = await openProviders("/providers/v1");
  await submit("#provider-program-form");
  assert.ok(title());
  assert.deepEqual(api.calls("POST", /programs$/), []);
});

test("a provider with no Programs shows the empty states", async () => {
  const data = providerData();
  data.programs = [];
  await openProviders("/providers/v1", { data });
  assert.match(pageText(), /No programs are linked to this provider\./);
  assert.equal($(programSelect).hasAttribute("disabled"), true);
});

test("deactivating a provider asks first, then reloads the provider list", async () => {
  const { api } = await openProviders("/providers/v1");
  await click("[data-deactivate-provider='v1']");
  await click("#deactivate-provider-dialog button[value='cancel']");
  assert.equal($("#deactivate-provider-dialog").open, false);
  assert.deepEqual(api.calls("DELETE", /^providers\/v1$/), []);
  const reads = api.calls("GET", /^providers$/).length;
  await deactivate();
  assert.equal(title(), undefined);
  assert.equal(api.calls("DELETE", /^providers\/v1$/).length, 1);
  assert.equal(api.calls("GET", /^providers$/).length, reads + 1);
  assert.ok(toastText().includes(t("admin.toast.providerDeactivated")));
});

test("a failed deactivation keeps the provider and shows why", async () => {
  await openProviders("/providers/v1", {
    setup: (api) =>
      api.fail("DELETE", /^providers\/v1$/, 409, "provider_has_sites"),
  });
  await deactivate();
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "provider_has_sites");
  assert.equal(title(), "Example Provider");
});

test("a provider list that fails to reload after deactivation shows the error", async () => {
  const { api } = await openProviders("/providers/v1");
  api.fail("GET", /^providers$/, 503, "providers_unavailable");
  await deactivate();
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "providers_unavailable");
});

test("a compliance manager sees provider details without management tools", async () => {
  const { api } = await openProviders("/providers/v1?section=access", {
    role: "compliance-manager",
  });
  assert.equal(title(), "Example Provider");
  assert.ok(missing("a[href$='section=access']"));
  assert.ok(missing("#add-provider-manager"));
  assert.ok(missing("[data-deactivate-provider]"));
  assert.deepEqual(api.calls("GET", /manager-memberships|grants|^people$/), []);
});

test("creating a provider opens its record", async () => {
  // Opened from the list, so the directory is already loaded.
  const { api } = await openProviders("/providers");
  await routeTo("/providers/new");
  assert.equal($(backLink).getAttribute("href"), "/providers");
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  const directoryReads = api.calls("GET", /^programs$/).length;
  await click("#provider-form button[type='submit']");
  assert.equal(url(), "/providers/new-provider");
  assert.equal(title(), "New Provider");
  // The create reply is enough; a full directory reload costs every create a round trip.
  assert.equal(api.calls("GET", /^programs$/).length, directoryReads);
});

test("a new provider is listed when the user returns to Providers", async () => {
  const { api } = await openProviders("/providers");
  await routeTo("/providers/new");
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  const providerReads = api.calls("GET", /^providers/).length;
  await routeTo("/providers");
  assert.ok(!missing('a[href="/providers/new-provider"]'));
  assert.equal(api.calls("GET", /^providers/).length, providerReads);
});

test("creating a provider from the new Site flow returns to that flow", async () => {
  await openProviders("/providers/new?returnTo=site-new");
  assert.equal($(backLink).getAttribute("href"), "/sites/new");
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  assert.equal(url(), "/sites/new?providerId=new-provider");
});

test("a duplicate provider name keeps the draft and explains the conflict", async () => {
  await openProviders("/providers/new", {
    setup: (api) =>
      api.fail("POST", /^providers$/, 409, "provider_already_exists"),
  });
  await fill(
    "#provider-form wa-input[name='provider-name']",
    "Example Provider",
  );
  await click("#provider-form button[type='submit']");
  assert.equal(
    $("#provider-form [data-form-save-error]").textContent.trim(),
    t("admin.errors.providerExists"),
  );
  assert.equal(
    $("#provider-form wa-input[name='provider-name']").value,
    "Example Provider",
  );
});

test("an empty provider name is not sent", async () => {
  const { api } = await openProviders("/providers/new");
  await submit("#provider-form");
  assert.equal($("#provider-form button[type='submit']").disabled, false);
  assert.deepEqual(api.calls("POST", /^providers$/), []);
});

test("leaving while a provider is created does not pull the user back", async () => {
  const held = gate();
  const { api } = await openProviders("/providers/new", {
    setup: (api) =>
      api.on("POST", /^providers$/, {
        delay: held.promise,
        json: { provider: { providerId: "v9", name: "New Provider" } },
      }),
  });
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  assert.equal(api.calls("POST", /^providers$/).length, 1);
  await click(backLink);
  assert.equal(url(), "/providers");
  held.release();
  await settle();
  assert.deepEqual(api.calls("GET", /^providers\/v9$/), []);
  assert.ok(!missing("#directory-search-input"));
  assert.equal(url(), "/providers");
});

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

test("empty list replies after adopting or deactivating leave empty lists", async () => {
  const { api } = await openProviders("/providers/v1", {
    setup: (api) =>
      api.on("POST", /^providers\/v1\/programs$/, () => {
        api.on("GET", /^programs$/, { json: {} });
        return { json: {} };
      }),
  });
  await fill(programSelect, "p3");
  await click(addProgram);
  assert.match(pageText(), /No programs are linked to this provider\./);
  api.on("DELETE", /^providers\/v1$/, () => {
    api.on("GET", /^providers$/, { json: {} });
    return { json: {} };
  });
  await deactivate();
  assert.equal(title(), undefined);
  assert.ok(toastText().includes(t("admin.toast.providerDeactivated")));
});
