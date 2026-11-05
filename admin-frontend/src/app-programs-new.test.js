import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  mountAdmin,
  routeTo,
  settle,
  window,
  missing,
  focused,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

const providerSelect = "wa-select[name='program-provider']";
const backLink = 'a[data-route]:has(> wa-icon[name="chevron-left"])';
const url = () => window.location.pathname + window.location.search;
const saveError = () =>
  $("#program-form [data-form-save-error]").textContent.trim();

/**
 * @param {string} path
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
const openPrograms = (path, options = {}) =>
  mountAdmin(path, { data: providerData(), ...options });

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
  const { api } = await openPrograms("/programs/new", { data });
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

test("a Program created from the new Site flow returns to it", async () => {
  const { api } = await openPrograms(
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
  await openPrograms("/programs/new?returnTo=provider&providerId=v1");
  assert.equal($(backLink).getAttribute("href"), "/providers/v1");
  await createProgram("Provider Program");
  assert.equal(url(), "/providers/v1");
});

test("the provider flow without a provider links back to Programs", async () => {
  await openPrograms("/programs/new?returnTo=provider");
  assert.equal($(backLink).getAttribute("href"), "/programs");
  await routeTo("/programs/new?returnTo=site-new");
  assert.equal($(backLink).getAttribute("href"), "/sites/new");
});

test("a new Program shows in search without a directory reload", async () => {
  // Opened from the directory, so it is already loaded.
  const { api } = await openPrograms("/sites");
  await routeTo("/programs/new?providerId=v1");
  await createProgram("Harbor Outreach");
  const programReads = api.calls("GET", /^programs$/).length;
  await routeTo("/sites?q=Harbor");
  assert.match($("#directory-results").textContent, /Harbor Outreach/);
  assert.equal(api.calls("GET", /^programs$/).length, programReads);
});

test("a duplicate Program name keeps the form and explains it", async () => {
  await openPrograms("/programs/new?providerId=v1", {
    setup: (api) =>
      api.fail("POST", /^programs$/, 409, "program_already_exists"),
  });
  await createProgram("Example Program");
  assert.equal(saveError(), t("admin.programs.duplicateHelp"));
});

test("a Program whose staff records changed while saving asks for a refresh", async () => {
  await openPrograms("/programs/new?providerId=v1", {
    setup: (api) =>
      // admin-programs.js createProgram sends this when a staff source changed mid-save.
      api.fail("POST", /^programs$/, 409, "staff_source_changed"),
  });
  await createProgram("Example Program");
  assert.equal(saveError(), t("admin.programs.staffSourceChanged"));
});

test("leaving while a Program is created does not pull the user back", async () => {
  const held = gate();
  const { api } = await openPrograms("/programs/new?providerId=v1", {
    setup: (api) =>
      api.on("POST", /^programs$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await fill("#program-form wa-input[name='program-name']", "Late");
  await click("#program-form button[type='submit']");
  assert.equal(api.calls("POST", /^programs$/).length, 1);
  await click(backLink);
  held.release();
  await settle();
  assert.ok(!missing("#directory-search-input"));
  assert.equal(url(), "/programs");
});
