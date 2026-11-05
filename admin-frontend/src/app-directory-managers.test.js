import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  pageError,
  routeTo,
  settle,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { managerData } from "../../e2e/admin-tests/site-access-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { appMessageError } from "./admin-error-messages.js";

// These tests need <admin-app>: they move between the directory and Site or manager
// records, or move <admin-app> itself in the page.

const results = "#directory-results";
const tabs = `nav[aria-label="${t("admin.directory.sections")}"]`;
/** @param {string} titleId */
const listText = (titleId) =>
  $(`[aria-labelledby="${titleId}"] ul, [aria-labelledby="${titleId}"] ol`)
    .textContent;

/** Hold GET people until the returned release runs. @param {any} api */
function holdPeople(api) {
  const held = gate();
  api.on("GET", /^people$/, async () => {
    await held.promise;
    return undefined;
  });
  return held;
}

test("the new manager form shares a manager read the directory started", async () => {
  /** @type {any} */
  let held;
  const { api } = await mountAdmin("/managers", {
    setup: (api) => (held = holdPeople(api)),
  });
  const programReads = api.calls("GET", /^programs\/[^/]+$/).length;
  // GET people is still held, so a second manager read would repeat these program reads.
  await routeTo("/managers/new");
  held.release();
  await settle();
  assert.equal(api.calls("GET", /^programs\/[^/]+$/).length, programReads);
  assert.ok(!missing("#manager-record-title"));
});

test("a manager lookup that finishes off the directory leaves the page alone", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/sites?q=Example", {
    setup: (api) => (held = holdPeople(api)),
  });
  await routeTo("/profile");
  await fill('#my-profile-form wa-input[name="firstName"]', "Typed");
  held.release();
  await settle();
  assert.equal($('#my-profile-form wa-input[name="firstName"]').value, "Typed");
  assert.ok(missing(results));
});

test("a manager lookup that ends on the Managers tab redraws its list", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/sites?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  await click("#clear-directory-search");
  await click(`${tabs} a[href="/managers"]`);
  assert.equal(window.location.pathname, "/managers");
  held.release();
  await settle();
  assert.ok(
    !missing('[aria-labelledby="managers-title"] a[href="/managers/u1"]'),
  );
});

test("an error in <admin-app>'s error line keeps a Site manager's unsaved edits", async () => {
  await mountAdmin("/managers/u1");
  const firstName =
    '#site-manager-record-form wa-input[name="manager-first-name"]';
  await fill(firstName, "Edited");
  // What a failed manager action does; <admin-app> redraws and reattaches the page.
  $("admin-site-manager-page").reportError(appMessageError("Something failed"));
  await settle();
  assert.equal(pageError(), "Something failed");
  assert.equal($(firstName).value, "Edited");
  assert.equal($("#site-manager-record-form").dataset.isDirty, "true");
});

test("an app moved in the page lists the managers again", async () => {
  const { app, api } = await mountAdmin("/managers");
  app.remove();
  document.body.append(app);
  await settle();
  assert.equal(api.calls("GET", /^people$/).length, 2);
  assert.ok(listText("managers-title").includes("Alex Example"));
});

test("an app moved during a stuck manager search finishes the search", async () => {
  /** @type {any} */
  let held;
  const { app } = await mountAdmin("/managers?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  const alex = `${results} a[href="/managers/u1"]`;
  assert.ok(missing(alex));
  app.remove();
  document.body.append(app);
  await settle();
  held.release();
  await settle();
  assert.ok(!missing(alex));
});

test("a manager search outdated by moving the app leaves the redraw to the newer search", async () => {
  /** @type {any} */
  let held;
  const { app } = await mountAdmin("/managers?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  app.remove();
  document.body.append(app);
  await settle();
  let redraws = 0;
  app.addEventListener("page-rendered", () => redraws++);
  held.release();
  await settle();
  assert.equal(redraws, 1);
  assert.ok(!missing(`${results} a[href="/managers/u1"]`));
});

test("an app moved during a stuck manager read starts a new one", async () => {
  /** @type {any} */
  let held;
  const { app, api } = await mountAdmin("/managers", {
    setup: (api) => (held = holdPeople(api)),
  });
  const programReads = api.calls("GET", /^programs\/[^/]+$/).length;
  app.remove();
  document.body.append(app);
  await settle();
  // A second round of Program reads shows a new manager read started, not queued behind the held one.
  assert.equal(api.calls("GET", /^programs\/[^/]+$/).length, 2 * programReads);
  held.release();
  await settle();
});

// The managers directory, with the Site managers <admin-app> reads for it.

/** @param {string} path @param {Parameters<typeof mountAdmin>[1]} [options] */
const openManagersInApp = (path, options = {}) =>
  mountAdmin(path, { data: managerData(), ...options });

const directoryRows = () =>
  $$('[aria-labelledby="managers-title"] li').map((row) =>
    row.textContent.replace(/\s+/g, " ").trim(),
  );
const managerTitle = () => $("#manager-record-title").textContent.trim();

test("opening a manager while the directory loads waits for that load", async () => {
  const held = gate();
  const { api } = await openManagersInApp("/managers", {
    setup: (api) =>
      api.on("GET", /^people$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  assert.equal(api.calls("GET", /^people$/).length, 1);
  // admin-api shares a repeated people read, so a second directory load would
  // show only as an extra programs/p1 read.
  const programReads = api.calls("GET", /^programs\/p1$/).length;
  await routeTo("/managers/u3");
  held.release();
  await settle();
  assert.equal(managerTitle(), "Morgan Person");
  assert.equal(api.calls("GET", /^people$/).length, 1);
  assert.equal(api.calls("GET", /^programs\/p1$/).length, programReads);
});

test("an unassigned manager shows a placeholder and a missing manager an error", async () => {
  const data = managerData();
  data.people.push({
    personId: "u5",
    firstName: "Sam",
    lastName: "Unassigned",
    email: "sam@example.org",
    siteManager: true,
    status: "active",
  });
  await openManagersInApp("/managers", { data });
  assert.ok(directoryRows().some((row) => row.includes("No site assigned")));
  await routeTo("/managers/missing");
  assert.equal(pageError(), "Site manager not found.");
});
