import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  pageError,
  pageText,
  routeTo,
  settle,
  tick,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import { managerData } from "../../e2e/admin-tests/site-access-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// These tests need <admin-app>: it holds the Site manager list the directory searches,
// and the Site and Site manager records whose breadcrumbs these check.

const SEARCH_DELAY_MS = 300;
const results = "#directory-results";
const resultStatus = `${results} p[role='status']`;
const tabs = `nav[aria-label="${t("admin.directory.sections")}"]`;
const query = () => new URLSearchParams(window.location.search);
/** @param {string} titleId */
const rows = (titleId) => $$(`[aria-labelledby="${titleId}"] li`);
/** @param {string} titleId */
const listText = (titleId) =>
  $(`[aria-labelledby="${titleId}"] ul, [aria-labelledby="${titleId}"] ol`)
    .textContent;

/** Type into the search box and wait out its debounce. @param {string} value */
async function searchFor(value) {
  await fill("#directory-search-input", value);
  await tick(SEARCH_DELAY_MS);
}

/** Hold GET people until the returned release runs. @param {any} api */
function holdPeople(api) {
  const held = gate();
  api.on("GET", /^people$/, async () => {
    await held.promise;
    return undefined;
  });
  return held;
}

test("search lists matching Sites, Programs, Providers and managers", async () => {
  await mountAdmin("/sites", {
    setup: (api) => {
      api.data.programs[0] = {
        ...api.data.programs[0],
        providerName: "Example Provider",
      };
    },
  });
  await searchFor("Example");
  assert.equal(query().get("q"), "Example");
  assert.equal($$(`${results} h3`).length, 4);
  assert.ok(
    $(results).textContent.includes("Example Program — Example Provider"),
  );
  assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.resultCount", { count: 4 }),
  );
});

test("search reports a manager lookup failure and recovers on the next search", async () => {
  await mountAdmin("/sites?q=Alex", {
    setup: (api) => api.on("GET", /^people$/, failTimes(1)),
  });
  assert.equal($(resultStatus).textContent, t("admin.directory.managerError"));
  await searchFor("Alexa");
  await searchFor("Alex");
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.resultCount", { count: 1 }),
  );
});

test("search shows a loading line until managers arrive", async () => {
  /** @type {any} */
  let held;
  const { api } = await mountAdmin("/sites?q=Nothing", {
    setup: (api) => (held = holdPeople(api)),
  });
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.managerLoading"),
  );
  await searchFor("Nothing at all");
  assert.equal(query().get("q"), "Nothing at all");
  held.release();
  await settle();
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.resultCount", { count: 0 }),
  );
  assert.equal(api.calls("GET", /^people$/).length, 1);
});

test("returning to a search before managers arrive still shows them", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/sites?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  await routeTo("/providers");
  await routeTo("/sites?q=Alex");
  held.release();
  await settle();
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.resultCount", { count: 1 }),
  );
  assert.ok(!missing(`${results} a[href="/managers/u1"]`));
});

test("a second search reuses the managers the first one loaded", async () => {
  const { api } = await mountAdmin("/sites?q=Alex");
  assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  await searchFor("Example");
  assert.ok(!missing(`${results} a[href="/sites/s1"]`));
  assert.equal(api.calls("GET", /^people$/).length, 1);
});

test("a failed manager lookup keeps the Site results", async () => {
  await mountAdmin("/sites?q=Example", {
    setup: (api) => api.fail("GET", /^people$/),
  });
  assert.equal($(resultStatus).textContent, t("admin.directory.managerError"));
  assert.ok(!missing(`${results} a[href="/sites/s1"]`));
});

test("a manager lookup that returns after the search is cleared does not redraw results", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/sites?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  await click("#clear-directory-search");
  const nav = $(tabs);
  held.release();
  await settle();
  assert.ok($(tabs) === nav);
  assert.ok(missing("#directory-results-title"));
});

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

test("manager filters narrow the Site manager list", async () => {
  await mountAdmin("/managers", {
    setup: (api) => {
      api.data.sites.push(
        { siteId: "s4", siteName: "Listed Name", status: "active" },
        { siteId: "s5", status: "active" },
      );
      api.data.memberships = [
        { membershipId: "m1", userId: "u1", status: "active" },
      ];
      api.data.programs.push({
        programId: "p3",
        name: "Other Program",
        providerId: "v1",
        status: "active",
      });
      api.data.programUsers.p3 = [
        {
          userId: "u7",
          programId: "p3",
          firstName: "Jamie",
          lastName: "Other",
          email: "jamie@example.org",
          status: "active",
          siteManager: true,
        },
      ];
    },
  });
  const filter = (/** @type {string} */ name) =>
    `#manager-directory-filters wa-select[name="${name}"]`;
  assert.equal(rows("managers-title").length, 2);
  assert.equal(
    $('#manager-directory-filters wa-option[value="s4"]').textContent,
    "Listed Name",
  );
  assert.equal(
    $('#manager-directory-filters wa-option[value="s5"]').textContent,
    "s5",
  );
  await fill(filter("program"), "p1");
  assert.equal(query().get("program"), "p1");
  assert.equal(rows("managers-title").length, 1);
  assert.ok(listText("managers-title").includes("Alex Example"));
  await fill(filter("site"), "s1");
  assert.equal(query().get("site"), "s1");
  await fill(filter("program"), "");
  assert.equal(query().has("program"), false);
  assert.equal(rows("managers-title").length, 1);
  await fill(filter("site"), "");
  assert.equal(window.location.pathname + window.location.search, "/managers");
  assert.equal(rows("managers-title").length, 2);
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

test("breadcrumbs fall back to generic labels for unnamed parents", async () => {
  await mountAdmin("/sites/s1", {
    setup: (api) => {
      api.data.providers.push({ providerId: "v9", name: "", status: "active" });
      api.data.programs.push({
        programId: "p9",
        name: "",
        providerId: "v9",
        status: "active",
      });
      api.data.sites[0] = {
        ...api.data.sites[0],
        providerId: "v9",
        providerName: "",
        leadProgramId: "p9",
        programName: "",
      };
    },
  });
  const crumbs = `nav[aria-label="${t("admin.breadcrumb.label")}"]`;
  assert.equal(
    $(`${crumbs} a[href="/providers/v9"]`).textContent,
    t("admin.breadcrumb.provider"),
  );
  assert.equal(
    $(`${crumbs} a[href="/programs/p9"]`).textContent,
    t("admin.breadcrumb.program"),
  );
});

for (const [query, field] of [
  ["Alex Example", "full name"],
  ["Example Program", "Program"],
  ["Example Site", "assigned Site"],
])
  test(`search finds a manager by ${field}`, async () => {
    await mountAdmin(`/sites?q=${encodeURIComponent(query)}`);
    assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  });

for (const tab of ["managers", "providers"])
  test(`search from the ${tab} tab shows the shared results`, async () => {
    await mountAdmin(`/${tab}?q=Alex`);
    assert.ok(missing(tabs));
    assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  });

test("clearing a search on the Managers tab redraws the list once managers load", async () => {
  /** @type {any} */
  let held;
  await mountAdmin("/managers?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  await click("#clear-directory-search");
  held.release();
  await settle();
  assert.ok(
    !missing('[aria-labelledby="managers-title"] a[href="/managers/u1"]'),
  );
});

const crumbs = `nav[aria-label="${t("admin.breadcrumb.label")}"]`;

test("breadcrumbs show a provider's name as text and encode parent IDs", async () => {
  await mountAdmin("/sites/s1", {
    setup: (api) => {
      api.data.providers.push({
        providerId: "v/9",
        name: "<b>Bold</b> & Co",
        status: "active",
      });
      api.data.programs.push({
        programId: "p/9",
        name: "Slash Program",
        providerId: "v/9",
        status: "active",
      });
      api.data.sites[0] = {
        ...api.data.sites[0],
        providerId: "v/9",
        providerName: "<b>Bold</b> & Co",
        leadProgramId: "p/9",
      };
    },
  });
  assert.equal(
    $(`${crumbs} a[href="/providers/v%2F9"]`).textContent,
    "<b>Bold</b> & Co",
  );
  assert.ok(!missing(`${crumbs} a[href="/programs/p%2F9"]`));
});

for (const [path, kind] of [
  ["/sites/s1", "site"],
  ["/programs/p1", "program"],
  ["/providers/v1", "provider"],
])
  test(`a ${kind} page's breadcrumb names the ${kind} as the current page`, async () => {
    await mountAdmin(path);
    assert.equal(
      $(`${crumbs} [aria-current="page"]`).textContent,
      t(`admin.breadcrumb.${kind}`),
    );
  });

test("a Site with no provider or Program shows no parent links", async () => {
  await mountAdmin("/sites/s1", {
    setup: (api) => {
      api.data.sites[0] = {
        ...api.data.sites[0],
        providerId: undefined,
        providerName: undefined,
        leadProgramId: undefined,
      };
    },
  });
  assert.deepEqual(
    $$(`${crumbs} a`).map((link) => link.getAttribute("href")),
    ["/sites"],
  );
});

test("a manager's breadcrumb leads back through the manager directory and their Program", async () => {
  await mountAdmin("/managers/u1");
  assert.deepEqual(
    $$(`${crumbs} a`).map((link) => link.getAttribute("href")),
    ["/managers", "/providers/v1", "/programs/p1"],
  );
  assert.equal(
    $(`${crumbs} [aria-current="page"]`).textContent,
    t("admin.breadcrumb.manager"),
  );
});

test("an error in <admin-app>'s error line keeps a Site manager's unsaved edits", async () => {
  await mountAdmin("/managers/u1");
  const firstName =
    '#site-manager-record-form wa-input[name="manager-first-name"]';
  await fill(firstName, "Edited");
  // What a failed manager action does; <admin-app> redraws and reattaches the page.
  $("admin-site-manager-page").reportError(new Error("Something failed"));
  await settle();
  assert.equal(pageError(), "Something failed");
  assert.equal($(firstName).value, "Edited");
  assert.equal($("#site-manager-record-form").dataset.isDirty, "true");
});

test("search lists managers by email and Sites by address", async () => {
  await mountAdmin("/sites?q=nameless", {
    setup: (api) => {
      api.data.people.push({
        personId: "u5",
        firstName: "",
        lastName: "",
        email: "nameless@example.org",
        status: "active",
      });
      api.data.programUsers.p1.push({
        userId: "u5",
        personId: "u5",
        email: "nameless@example.org",
        status: "active",
        siteManager: true,
      });
      api.data.sites.push({
        siteId: "s8",
        siteName: "Plain Site",
        address: "1 Nameless Way",
        status: "active",
      });
    },
  });
  assert.ok(
    $(`${results} a[href="/managers/u5"]`).textContent.includes(
      "nameless@example.org",
    ),
  );
  assert.ok(
    $(`${results} a[href="/sites/s8"]`).textContent.includes("Plain Site"),
  );
});

test("an app moved in the page lists the managers again", async () => {
  const { app, api } = await mountAdmin("/managers");
  app.remove();
  document.body.append(app);
  await settle();
  assert.equal(api.calls("GET", /^people$/).length, 2);
  assert.ok(listText("managers-title").includes("Alex Example"));
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

test("the manager directory lists people and legacy staff and filters them", async () => {
  const data = managerData();
  data.people.push({
    personId: "u5",
    firstName: "Sam",
    lastName: "North",
    email: "sam@example.org",
    siteManager: true,
    status: "active",
  });
  data.siteItems.s3 = [
    {
      sk: "MEMBERSHIP#m5",
      type: "managerMembership",
      membershipId: "m5",
      personId: "u5",
      name: "Sam North",
      email: "sam@example.org",
      status: "active",
    },
  ];
  await openManagersInApp("/managers", { data });
  assert.equal(directoryRows().length, 3);
  assert.match(directoryRows()[0], /Alex Example/);
  assert.match(directoryRows()[2], /Sam North/);
  await routeTo("/managers?program=p3");
  assert.match(pageText(), /No site managers match these filters\./);
  await routeTo("/managers?site=s1&program=p1");
  assert.equal(directoryRows().length, 2);
  assert.match(directoryRows()[0], /Alex Example/);
  assert.match(directoryRows()[1], /Morgan Person/);
  await fill('#manager-directory-filters wa-select[name="program"]', "");
  assert.equal(
    window.location.pathname + window.location.search,
    "/managers?site=s1",
  );
  await fill('#manager-directory-filters wa-select[name="site"]', "");
  assert.equal(window.location.pathname + window.location.search, "/managers");
});

test("legacy staff join the directory through an email-only Site membership", async () => {
  const data = managerData();
  data.programUsers.p1.push({
    userId: "u10",
    firstName: "Former",
    lastName: "Staff",
    email: "former@example.org",
    status: "inactive",
    siteManager: true,
  });
  // Older memberships carry only an email; they still match Program staff.
  data.siteItems.s3 = [
    {
      sk: "MEMBERSHIP#m50",
      type: "managerMembership",
      membershipId: "m50",
      name: "Jordan Staff",
      email: "JORDAN@example.org",
      status: "active",
    },
  ];
  await openManagersInApp("/managers", { data });
  // The Site must land on Jordan's own row, not just somewhere in the list.
  assert.match(
    directoryRows().find((row) => row.includes("Jordan Staff")) || "",
    /North Site/,
  );
  assert.ok(!directoryRows().some((row) => row.includes("Former Staff")));
});

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
