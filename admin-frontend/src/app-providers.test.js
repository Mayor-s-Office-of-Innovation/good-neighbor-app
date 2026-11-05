import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  mountPage,
  pageError,
  pageText,
  revisitPage,
  routeTo,
  settle,
  submit,
  toastText,
  window,
  missing,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import "./pages/directory/directory-page.js";
import "./pages/provider/provider-page.js";
import { appMessageError } from "./admin-error-messages.js";

// pages/provider/provider.templates.js and provider.bindings.js have no
// catalog key for this copy, so tests match their English.

/** The Provider page's own reads and writes; any other request fails a page test. */
const providerCalls = [
  /^GET providers\/[^/]+$/,
  /^GET providers\/[^/]+\/(manager-memberships|grants)$/,
  /^GET (people|providers|programs)$/,
  /^(PATCH|DELETE) providers\/[^/]+$/,
  /^POST providers(\/[^/]+\/programs)?$/,
];

/**
 * <admin-provider-page> alone, without <admin-app>, following the provider routes.
 * Its errors show through pageError(), as <admin-app>'s error line would show them.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openProviderPage = (path, options = {}) =>
  mountPage("admin-provider-page", path, {
    calls: providerCalls,
    follow: ["provider", "provider-new", "provider-manager"],
    recordErrors: true,
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
  const { api } = await openProviderPage("/providers/v1");
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
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.fail("PATCH", /^providers\/v1$/, 409, "provider_already_exists"),
  });
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Second Provider",
  );
  await click("#provider-details-form [data-save-button]");
  assert.equal(pageError(), t("admin.errors.providerExists"));
});

test("a provider adopts an available Program and the list reloads", async () => {
  const data = providerData();
  const { api } = await openProviderPage("/providers/v1", {
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
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.fail("POST", /^providers\/v1\/programs$/, 409, "program_has_sites"),
  });
  await fill(programSelect, "p3");
  await click(addProgram);
  assert.equal(pageError(), t("admin.errors.programHasSites"));
});

test("adding a Program reports other failures as they come", async () => {
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.fail("POST", /^providers\/v1\/programs$/, 500, "program_not_found"),
  });
  await fill(programSelect, "p3");
  await click(addProgram);
  assert.equal(pageError(), t("admin.errors.programUnavailable"));
});

test("an empty Program choice does not call the API", async () => {
  const { api } = await openProviderPage("/providers/v1");
  await submit("#provider-program-form");
  assert.ok(title());
  assert.deepEqual(api.calls("POST", /programs$/), []);
});

test("a provider with no Programs shows the empty states", async () => {
  const data = providerData();
  data.programs = [];
  await openProviderPage("/providers/v1", { data });
  assert.match(pageText(), /No programs are linked to this provider\./);
  assert.equal($(programSelect).hasAttribute("disabled"), true);
});

test("deactivating a provider asks first, then reloads the provider list", async () => {
  const { api } = await openProviderPage("/providers/v1");
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
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.fail("DELETE", /^providers\/v1$/, 404, "provider_not_found"),
  });
  await deactivate();
  assert.equal(pageError(), t("admin.errors.providerUnavailable"));
  assert.equal(title(), "Example Provider");
});

test("a deactivation that fails after the user leaves still shows why", async () => {
  const held = gate();
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.on("DELETE", /^providers\/v1$/, {
        delay: held.promise,
        status: 404,
        json: { error: "provider_not_found", message: "provider_not_found" },
      }),
  });
  await deactivate();
  await routeTo("/sites");
  held.release();
  await settle();
  assert.equal(pageError(), t("admin.errors.providerUnavailable"));
});

/** Provider data with the second provider active, so a test can open it. */
function twoProviders() {
  const data = providerData();
  data.providers[1].status = "active";
  return data;
}

test("a rename that finishes after the user opens another provider leaves that provider shown", async () => {
  const held = gate();
  await openProviderPage("/providers/v1", {
    data: twoProviders(),
    setup: (api) =>
      api.on("PATCH", /^providers\/v1$/, async () => {
        await held.promise;
        return { json: { provider: { providerId: "v1", name: "Renamed" } } };
      }),
  });
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Renamed",
  );
  await submit("#provider-details-form");
  await routeTo("/providers/v2");
  held.release();
  await settle();
  assert.equal(title(), "Second Provider");
});

test("a deactivation that finishes after the user opens another provider leaves that provider shown", async () => {
  const held = gate();
  const { page } = await openProviderPage("/providers/v1", {
    data: twoProviders(),
    setup: (api) =>
      api.on("DELETE", /^providers\/v1$/, async () => {
        await held.promise;
        return { json: {} };
      }),
  });
  await deactivate();
  await routeTo("/providers/v2");
  // An error the next page showed must stay until the user reads it.
  page.reportError(appMessageError("Second provider read failed"));
  held.release();
  await settle();
  assert.equal(title(), "Second Provider");
  assert.equal(pageError(), "Second provider read failed");
});

test("a deactivation whose list reread fails after the user opens another provider leaves that provider's error", async () => {
  const held = gate();
  const { page, api } = await openProviderPage("/providers/v1", {
    data: twoProviders(),
    setup: (api) =>
      api.on("DELETE", /^providers\/v1$/, async () => {
        await held.promise;
        return { json: {} };
      }),
  });
  await deactivate();
  await routeTo("/providers/v2");
  page.reportError(appMessageError("Second provider read failed"));
  api.fail("GET", /^providers$/, 503, "providers_unavailable");
  const reads = api.calls("GET", /^providers$/).length;
  held.release();
  await settle();
  // The reread ran, so its failure is what the page held back.
  assert.ok(api.calls("GET", /^providers$/).length > reads);
  assert.equal(title(), "Second Provider");
  assert.equal(pageError(), "Second provider read failed");
});

test("a provider list that fails to reload after deactivation shows the error", async () => {
  const { api } = await openProviderPage("/providers/v1");
  api.fail("GET", /^providers$/, 503, "providers_unavailable");
  await deactivate();
  assert.equal(pageError(), t("admin.toast.requestFailed"));
});

test("a compliance manager sees provider details without management tools", async () => {
  const { api } = await openProviderPage("/providers/v1?section=access", {
    role: "compliance-manager",
  });
  assert.equal(title(), "Example Provider");
  assert.ok(missing("a[href$='section=access']"));
  assert.ok(missing("#add-provider-manager"));
  assert.ok(missing("[data-deactivate-provider]"));
  assert.deepEqual(api.calls("GET", /manager-memberships|grants|^people$/), []);
});

test("creating a provider opens its record", async () => {
  const { api } = await openProviderPage("/providers/new");
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
  const { catalog, session } = await openProviderPage("/providers/new", {
    sites: true,
  });
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  // The directory page shares the provider page's catalog, as both share <admin-app>'s.
  const { api } = await mountPage("admin-directory-page", "/providers", {
    calls: [],
    catalog,
    session,
  });
  assert.ok(!missing('a[href="/providers/new-provider"]'));
  assert.deepEqual(api.calls("GET", /^providers/), []);
});

test("creating a provider from the new Site flow returns to that flow", async () => {
  await openProviderPage("/providers/new?returnTo=site-new");
  assert.equal($(backLink).getAttribute("href"), "/sites/new");
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  assert.equal(url(), "/sites/new?providerId=new-provider");
});

test("a search in the new provider address still reads the manager directory", async () => {
  // A ?q= in the URL preloads the manager directory, so its reads are this page's calls too.
  const { api, catalog } = await openProviderPage("/providers/new?q=Alex", {
    calls: [
      ...providerCalls,
      /^GET programs\/[^/]+$/,
      /^GET sites\/[^/]+\/manager-memberships$/,
      /^GET sites\/[^/]+\?roster=1$/,
      // The manager read needs the Site list first.
      /^GET (providers\?directory=1|programs|oversight-options|program-managers)$/,
    ],
  });
  assert.ok(!missing("#provider-form"));
  assert.equal(api.calls("GET", /^people$/).length, 1);
  // Without the Site list first, the search would show Alex with no Sites.
  assert.deepEqual(
    catalog.managers.map((/** @type {any} */ manager) =>
      manager.assignedSites.map((/** @type {any} */ site) => site.siteId),
    ),
    [["s1"]],
  );
});

test("a failed Site list read leaves the manager search for the next visit", async () => {
  const { api, catalog, session } = await openProviderPage(
    "/providers/new?q=Alex",
    {
      calls: [
        ...providerCalls,
        /^GET programs\/[^/]+$/,
        /^GET sites\/[^/]+\/manager-memberships$/,
        /^GET sites\/[^/]+\?roster=1$/,
        /^GET (providers\?directory=1|programs|oversight-options|program-managers)$/,
      ],
      setup: (api) =>
        api.on("GET", /^providers\?directory=1$/, failTimes(1, 503)),
    },
  );
  // Read without the Sites, the managers would list none and never be read again.
  assert.equal(api.calls("GET", /^people$/).length, 0);
  await revisitPage("/providers/new?q=Alex");
  assert.equal(api.calls("GET", /^people$/).length, 1);
  // A search by Site name finds Alex only if his Sites came with the read.
  await mountPage("admin-directory-page", "/sites?q=Example%20Site", {
    calls: [],
    catalog,
    session,
  });
  assert.ok(!missing('#directory-results a[href="/managers/u1"]'));
});

test("a duplicate provider name keeps the draft and explains the conflict", async () => {
  await openProviderPage("/providers/new", {
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
  const { api } = await openProviderPage("/providers/new");
  await submit("#provider-form");
  assert.equal($("#provider-form button[type='submit']").disabled, false);
  assert.deepEqual(api.calls("POST", /^providers$/), []);
});

test("leaving while a provider is created does not pull the user back", async () => {
  const held = gate();
  const { api } = await openProviderPage("/providers/new", {
    setup: (api) =>
      api.on("POST", /^providers$/, {
        delay: held.promise,
        json: { provider: { providerId: "v9", name: "New Provider" } },
      }),
  });
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  assert.equal(api.calls("POST", /^providers$/).length, 1);
  await routeTo("/providers");
  held.release();
  await settle();
  assert.deepEqual(api.calls("GET", /^providers\/v9$/), []);
  assert.equal(url(), "/providers");
});

test("a provider create that finishes after leave() doesn't navigate, even at the same address", async () => {
  const held = gate();
  const { page } = await openProviderPage("/providers/new", {
    setup: (api) =>
      api.on("POST", /^providers$/, {
        delay: held.promise,
        json: { provider: { providerId: "v9", name: "New Provider" } },
      }),
  });
  await fill("#provider-form wa-input[name='provider-name']", "New Provider");
  await click("#provider-form button[type='submit']");
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  await settle();
  assert.equal(url(), "/providers/new");
});

test("empty list replies after adopting or deactivating leave empty lists", async () => {
  const { api } = await openProviderPage("/providers/v1", {
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

test("a compliance manager can't add or create Programs from a provider", async () => {
  await openProviderPage("/providers/v1", { role: "compliance-manager" });
  assert.equal(title(), "Example Provider");
  assert.ok(missing("#provider-program-form"));
  assert.ok(missing('a[href^="/programs/new"]'));
});

test("a deactivation that works after a failed one clears the error", async () => {
  const { api } = await openProviderPage("/providers/v1");
  api.fail("DELETE", /^providers\/v1$/, 404, "provider_not_found");
  await deactivate();
  assert.equal(pageError(), t("admin.errors.providerUnavailable"));
  api.on("DELETE", /^providers\/v1$/, { json: {} });
  await deactivate();
  assert.equal(pageError(), "");
  assert.equal(title(), undefined);
});

test("the mounted provider page saves a rename to its own catalog", async () => {
  const { catalog } = await openProviderPage("/providers/v1");
  await fill(
    "#provider-details-form wa-input[name='provider-name']",
    "Renamed Provider",
  );
  await click("#provider-details-form [data-save-button]");
  assert.equal(
    catalog.providers.find((provider) => provider.providerId === "v1")?.name,
    "Renamed Provider",
  );
});

test("a redraw after the URL moves on still draws the route open() was given", async () => {
  const { page } = await openProviderPage("/providers/v1");
  window.history.replaceState({}, "", "/not-a-page");
  page.render();
  assert.ok(!missing("admin-provider-page h1"));
});

const crumbs = `nav[aria-label="${t("admin.breadcrumb.label")}"]`;

test("a provider page's breadcrumb names the provider as the current page", async () => {
  await openProviderPage("/providers/v1");
  assert.equal(
    $(`${crumbs} [aria-current="page"]`).textContent,
    t("admin.breadcrumb.provider"),
  );
});
