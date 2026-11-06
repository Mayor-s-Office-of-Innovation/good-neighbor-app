import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  mountPage,
  leavePage,
  settle,
  window,
  missing,
  focused,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { adminCatalog, createAdminCatalog } from "./admin-catalog.js";
import { currentRoute } from "./router.js";
import "./pages/program/program-page.js";

const providerSelect = "wa-select[name='program-provider']";
const backLink = 'a[data-route]:has(> wa-icon[name="chevron-left"])';
const url = () => window.location.pathname + window.location.search;
const saveError = () =>
  $("#program-form [data-form-save-error]").textContent.trim();

/**
 * The new Program form alone, with no app around it; any request but the create fails.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openNewProgramPage = (path, options = {}) =>
  mountPage("admin-program-page", path, {
    calls: [/^POST programs$/],
    data: providerData(),
    ...options,
  });

/** @param {string} name */
async function createProgram(name) {
  await fill("#program-form wa-input[name='program-name']", name);
  await click("#program-form button[type='submit']");
}

test("a new Program asks only for a name and an active provider", async () => {
  const data = providerData();
  data.providers.push({
    providerId: "v0",
    name: "Another Provider",
    status: "active",
  });
  const { api } = await openNewProgramPage("/programs/new", { data });
  assert.ok(focused("#new-program-title"));
  assert.equal($(backLink).getAttribute("href"), "/programs");
  assert.match(
    $("#new-program-title").parentElement.textContent,
    new RegExp(t("admin.programs.createWithoutStaff")),
  );
  assert.ok(missing("#program-form [name='program-staff']"));
  assert.deepEqual(
    [...$(providerSelect).querySelectorAll("wa-option")].map(
      (option) => option.value,
    ),
    ["v0", "v1"],
  );
  await fill(providerSelect, "v1");
  const directoryReads = api.calls("GET", /^programs$/).length;
  await createProgram("New Program");
  assert.equal(url(), "/programs/v1-new-program");
  // The create reply is enough; a full directory reload costs every create a round trip.
  assert.equal(api.calls("GET", /^programs$/).length, directoryReads);
  assert.deepEqual(api.calls("POST", /^programs$/)[0].body, {
    name: "New Program",
    providerId: "v1",
  });
});

test("the mounted Program page lists a new Program in its own catalog, not adminCatalog", async () => {
  const { catalog } = await openNewProgramPage("/programs/new?providerId=v1");
  await createProgram("Own Catalog");
  assert.ok(catalog.programs.some((p) => p.programId === "v1-own-catalog"));
  assert.deepEqual(adminCatalog.programs, []);
});

test("a page mount given a catalog shows that catalog's providers", async () => {
  const catalog = createAdminCatalog();
  catalog.seed({
    providers: [
      { providerId: "v9", name: "Seeded Provider", status: "active" },
    ],
    programs: [],
    oversightOptions: { departments: [], systemsOfCare: [] },
    programManagers: [],
  });
  await openNewProgramPage("/programs/new", { catalog });
  assert.deepEqual(
    [...$(providerSelect).querySelectorAll("wa-option")].map(
      (option) => option.value,
    ),
    ["v9"],
  );
});

test("a Program created from the new Site flow returns to it", async () => {
  const { api } = await openNewProgramPage(
    "/programs/new?returnTo=site-new&providerId=v1",
  );
  assert.equal($(backLink).getAttribute("href"), "/sites/new?providerId=v1");
  await createProgram("Draft Program");
  assert.equal(url(), "/sites/new?providerId=v1&programId=v1-draft-program");
  assert.deepEqual(api.calls("POST", /^programs$/)[0].body, {
    name: "Draft Program",
    providerId: "v1",
  });
});

test("a Program created from a provider returns to that provider", async () => {
  await openNewProgramPage("/programs/new?returnTo=provider&providerId=v1");
  assert.equal($(backLink).getAttribute("href"), "/providers/v1");
  await createProgram("Provider Program");
  assert.equal(url(), "/providers/v1");
});

test("the provider flow without a provider links back to Programs", async () => {
  const { page } = await openNewProgramPage("/programs/new?returnTo=provider");
  assert.equal($(backLink).getAttribute("href"), "/programs");
  // As <admin-app> does when the address changes and the page stays on screen.
  window.history.pushState({}, "", "/programs/new?returnTo=site-new");
  await page.open(currentRoute());
  page.render();
  assert.equal($(backLink).getAttribute("href"), "/sites/new");
});

test("a duplicate Program name keeps the form and explains it", async () => {
  await openNewProgramPage("/programs/new?providerId=v1", {
    setup: (api) =>
      api.fail("POST", /^programs$/, 409, "program_already_exists"),
  });
  await createProgram("Example Program");
  assert.equal(saveError(), t("admin.programs.duplicateHelp"));
});

test("a Program whose staff records changed while saving asks for a refresh", async () => {
  await openNewProgramPage("/programs/new?providerId=v1", {
    setup: (api) =>
      // admin-programs.js createProgram sends this when a staff source changed mid-save.
      api.fail("POST", /^programs$/, 409, "staff_source_changed"),
  });
  await createProgram("Example Program");
  assert.equal(saveError(), t("admin.programs.staffSourceChanged"));
});

/** @param {ReturnType<typeof gate>} held */
const holdCreate = (held) => ({
  setup: (/** @type {any} */ api) =>
    api.on("POST", /^programs$/, async () => {
      await held.promise;
      return undefined;
    }),
});

test("leaving while a Program is created does not pull the user back", async () => {
  const held = gate();
  const { api } = await openNewProgramPage(
    "/programs/new?providerId=v1",
    holdCreate(held),
  );
  await createProgram("Late");
  assert.equal(api.calls("POST", /^programs$/).length, 1);
  await leavePage("/programs");
  held.release();
  await settle();
  assert.equal(url(), "/programs");
});

test("a create that finishes after leave() doesn't navigate, even at the same address", async () => {
  const held = gate();
  const { page } = await openNewProgramPage(
    "/programs/new?providerId=v1",
    holdCreate(held),
  );
  await createProgram("Late");
  // The user may come back to this same address before the create finishes, so only the visit counter can stop the navigate.
  page.leave();
  held.release();
  await settle();
  assert.equal(url(), "/programs/new?providerId=v1");
});

test("a new Program makes the manager directory reload", async () => {
  const { catalog } = await openNewProgramPage("/programs/new?providerId=v1");
  catalog.markManagersLoaded(catalog.managersVersion);
  await createProgram("Harbor Outreach");
  assert.equal(catalog.managersLoaded, false);
});
