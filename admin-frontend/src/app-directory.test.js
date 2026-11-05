import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  mountPage,
  pageText,
  routeTo,
  settle,
  tick,
  userEvent,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import { managerData } from "../../e2e/admin-tests/site-access-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { createAdminCatalog } from "./admin-catalog.js";
import "./pages/directory/directory-page.js";

// pages/directory/directory.templates.js has no catalog key for this copy, so tests match its English.

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

/**
 * Mount <admin-directory-page> alone, without <admin-app>.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openDirectoryPage = (path, options = {}) =>
  mountPage("admin-directory-page", path, {
    follow: ["sites", "managers", "providers", "programs", "provider-managers"],
    calls: [
      /^GET providers\/[^/]+\/manager-memberships$/,
      /^GET sites\/[^/]+$/,
      /^PUT sites\/[^/]+\/deliberate-311$/,
      // A search in the URL reads the manager directory, which makes these calls.
      /^GET programs\/[^/]+$/,
      /^GET sites\/[^/]+\/manager-memberships$/,
      /^GET sites\/[^/]+\?roster=1$/,
      /^GET people$/,
    ],
    sites: true,
    ...options,
  });

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
  await openDirectoryPage("/sites", {
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

test("search matches Sites by oversight names, and clearing it restores the tabs", async () => {
  await openDirectoryPage("/sites?q=harbor", {
    setup: (api) => {
      api.data.sites[0].oversight = {
        ...api.data.sites[0].oversight,
        managingSystemOfCare: "Harbor Care",
      };
    },
  });
  assert.ok($(results).textContent.includes("Example Site"));
  assert.ok(missing(tabs));
  await click("#clear-directory-search");
  assert.equal(query().has("q"), false);
  assert.ok(!missing(tabs));
});

test("search reports a manager lookup failure and recovers on the next search", async () => {
  await openDirectoryPage("/sites?q=Alex", {
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
  const { api } = await openDirectoryPage("/sites?q=Nothing", {
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
  await openDirectoryPage("/sites?q=Alex", {
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
  const { api } = await openDirectoryPage("/sites?q=Alex");
  assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  await searchFor("Example");
  assert.ok(!missing(`${results} a[href="/sites/s1"]`));
  assert.equal(api.calls("GET", /^people$/).length, 1);
});

test("a failed manager lookup keeps the Site results", async () => {
  await openDirectoryPage("/sites?q=Example", {
    setup: (api) => api.fail("GET", /^people$/),
  });
  assert.equal($(resultStatus).textContent, t("admin.directory.managerError"));
  assert.ok(!missing(`${results} a[href="/sites/s1"]`));
});

test("a manager lookup that returns after the search is cleared does not redraw results", async () => {
  /** @type {any} */
  let held;
  const { api } = await openDirectoryPage("/sites?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  await click("#clear-directory-search");
  const nav = $(tabs);
  held.release();
  await settle();
  assert.equal(api.calls("GET", /^people$/).length, 1);
  assert.ok($(tabs) === nav);
  assert.ok(missing("#directory-results-title"));
});

test("discarding 311 changes puts each Site's checkbox back", async () => {
  const { api } = await openDirectoryPage("/sites");
  await fill('[data-site-311="s1"]', false);
  await click("[data-discard-311]");
  assert.equal($('[data-site-311="s1"]').checked, true);
  assert.ok(missing("[data-discard-311]"));
  assert.equal(api.calls("PUT", /deliberate-311$/).length, 0);
});

test("a 311 change someone else saved first waits for review, then saves", async () => {
  const { api } = await openDirectoryPage("/sites");
  await fill('[data-site-311="s1"]', false);
  // Another admin's save moves the Site's version, so ours is refused.
  api.data.sites[0].updatedAt = "2026-11-04T12:00:00.000Z";
  await click("[data-save-311]");
  assert.ok($("[data-save-311]").disabled);
  await click('[data-review-311="s1"]');
  await click("[data-save-311]");
  assert.equal(api.calls("PUT", /deliberate-311$/).length, 2);
  assert.equal(api.data.sites[0].deliberate311ProductionEnabled, false);
  assert.equal($('[data-site-311="s1"]').checked, false);
});

test("emptying the search returns to the Site list", async () => {
  await openDirectoryPage("/sites?q=Example");
  assert.ok(!missing("#directory-results-title"));
  await searchFor("");
  assert.equal(query().has("q"), false);
  assert.ok(!missing(tabs));
});

test("search waits for an input method to finish composing", async () => {
  await openDirectoryPage("/sites");
  const input = $("#directory-search-input");
  // An input method's composition events bubble, as these do.
  input.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
  await searchFor("Quiet");
  await tick(SEARCH_DELAY_MS);
  assert.equal(query().has("q"), false);
  input.dispatchEvent(new window.Event("compositionend", { bubbles: true }));
  await tick(SEARCH_DELAY_MS);
  assert.equal(query().get("q"), "Quiet");
});

test("submitting the search runs it at once", async () => {
  await openDirectoryPage("/sites");
  $("#directory-search-input").value = "Example";
  $("#directory-search").dispatchEvent(userEvent("submit"));
  await settle();
  assert.equal(query().get("q"), "Example");
});

test("Site filters update the address and the list", async () => {
  await openDirectoryPage("/sites", {
    setup: (api) => {
      api.data.sites[0].oversight = {
        ...api.data.sites[0].oversight,
        managingCityDepartment: "Example Department",
        managingSystemOfCare: "Example System",
        cityProgramManager: "Casey Manager",
      };
      api.data.sites.push({
        siteId: "s3",
        siteName: "Unnamed record",
        providerId: "v9",
        providerName: "Listed Provider",
        status: "active",
        oversight: { cityProgramManager: "Legacy Person" },
        managerMemberships: [],
      });
    },
  });
  const filter = (/** @type {string} */ name) =>
    `#site-directory-filters wa-select[name="${name}"]`;
  assert.equal(rows("sites-title").length, 2);
  assert.ok(listText("sites-title").includes("Listed Provider"));
  await fill(filter("department"), "Example Department");
  assert.equal(query().get("department"), "Example Department");
  assert.equal(rows("sites-title").length, 1);
  await fill(filter("system"), "Example System");
  assert.equal(query().get("system"), "Example System");
  await fill(filter("department"), "");
  assert.equal(query().has("department"), false);
  assert.equal(rows("sites-title").length, 1);
  await fill(filter("system"), "");
  assert.equal(query().has("system"), false);
  assert.equal(rows("sites-title").length, 2);
  await fill(filter("manager"), "Legacy Person");
  assert.equal(rows("sites-title").length, 1);
  assert.ok(listText("sites-title").includes("Unnamed record"));
});

test("an unknown manager name in the address still filters", async () => {
  await openDirectoryPage("/sites?manager=Nobody%20Known");
  assert.ok(
    $("admin-directory-page").textContent.includes(
      "No sites match these filters.",
    ),
  );
  assert.equal(
    $$('#site-directory-filters wa-option[value="Nobody Known"]').length,
    1,
  );
});

test("a Compliance manager sees their own Sites by default", async () => {
  await openDirectoryPage("/sites", {
    role: "compliance-manager",
    setup: (api) => {
      api.data.profile = { ...api.data.profile, firstName: "", lastName: "" };
      api.data.siteItems.s1.push({
        sk: "COMPLIANCE_MANAGER#pm1",
        type: "siteComplianceManagerAssignment",
        managerId: "pm1",
        status: "active",
      });
      api.data.sites.push({
        siteId: "s3",
        name: "North Site",
        providerId: "v1",
        leadProgramId: "p1",
        status: "active",
      });
    },
  });
  assert.equal(rows("sites-title").length, 1);
  assert.ok(listText("sites-title").includes("Example Site"));
  assert.ok(!missing('#site-directory-filters wa-option[value="id:pm1"]'));
});

test("the Providers tab lists the active providers", async () => {
  await openDirectoryPage("/providers", {
    setup: (api) =>
      api.data.providers.push({
        providerId: "v3",
        name: "Another Provider",
        status: "active",
      }),
  });
  assert.equal(rows("providers-title").length, 2);
  assert.ok($("admin-directory-page").textContent.includes("2 providers"));
});

test("the Providers tab says when there are no providers", async () => {
  await openDirectoryPage("/providers", {
    setup: (api) => {
      api.data.providers = [];
    },
  });
  assert.ok(
    $("admin-directory-page").textContent.includes(
      "No providers have been added.",
    ),
  );
});

test("a Provider manager read that finishes after leave() doesn't let the page open, even at the same address", async () => {
  const held = gate();
  const { page, api } = await openDirectoryPage("/provider-managers");
  api.on("GET", /^providers\/[^/]+\/manager-memberships$/, async () => {
    await held.promise;
    return undefined;
  });
  const reads = api.calls("GET", /manager-memberships$/).length;
  const opening = page.open({ name: "provider-managers" });
  await settle();
  // Left while the read is held, so the check after that read is what stops it.
  assert.ok(api.calls("GET", /manager-memberships$/).length > reads);
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  // False tells <admin-app> not to show the page it left.
  assert.equal(await opening, false);
});

test("a manager search read that finishes after the page goes off screen draws nothing", async () => {
  const held = gate();
  const { page } = await openDirectoryPage("/sites");
  // <admin-app> supplies the Site manager read; this one waits for the test.
  page.loadManagers = () => held.promise;
  /** @type {string[]} */
  const drawn = [];
  page.pathRendered = (/** @type {string} */ path) => drawn.push(path);
  await searchFor("Alex");
  drawn.length = 0;
  page.remove();
  held.release();
  await settle();
  assert.deepEqual(drawn, []);
});

test("a manager search that fails after the user leaves shows no error on the next visit", async () => {
  /** @type {(error: Error) => void} */
  let fail = () => {};
  const { page } = await openDirectoryPage("/sites");
  // <admin-app> supplies the Site manager read; this one fails when the test says.
  page.loadManagers = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  await searchFor("Alex");
  window.history.pushState({}, "", "/providers?q=Alex");
  page.leave();
  page.remove();
  const opening = page.open({ name: "providers" });
  fail(new Error("unavailable"));
  assert.equal(await opening, true);
  document.body.append(page);
  await settle();
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.managerLoading"),
  );
});

test("Site rows fall back to program and record details", async () => {
  await openDirectoryPage("/sites", {
    setup: (api) => {
      api.data.programs.push({
        programId: "p3",
        name: "Fallback Program",
        providerId: "v9",
        providerName: "Program Provider",
        status: "active",
      });
      api.data.sites.push(
        {
          siteId: "s6",
          siteName: "Alpha Record",
          leadProgramId: "p3",
          status: "active",
        },
        { siteId: "s7", status: "active" },
      );
    },
  });
  assert.equal(rows("sites-title").length, 3);
  for (const shown of ["Alpha Record", "Program Provider", "Fallback Program"])
    assert.ok(listText("sites-title").includes(shown), shown);
  assert.equal($('a[href="/sites/s7"] strong').textContent, "s7");
});

for (const [query, field] of [
  ["Alex Example", "full name"],
  ["Example Program", "Program"],
  ["Example Site", "assigned Site"],
])
  test(`search finds a manager by ${field}`, async () => {
    await openDirectoryPage(`/sites?q=${encodeURIComponent(query)}`);
    assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  });

for (const tab of ["managers", "providers"])
  test(`search from the ${tab} tab shows the shared results`, async () => {
    await openDirectoryPage(`/${tab}?q=Alex`);
    assert.ok(missing(tabs));
    assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  });

/** A Program whose ID needs encoding and whose provider has no name. */
const safeSleeping = {
  programId: "p/9",
  name: "Safe Sleeping Drop-In",
  providerId: "v1",
  providerName: "",
  status: "active",
};

test("a Program search result opens that Program", async () => {
  await openDirectoryPage("/sites?q=Safe", {
    setup: (api) => api.data.programs.push({ ...safeSleeping }),
  });
  assert.ok(!missing(`${results} a[href="/programs/p%2F9"]`));
  assert.ok(missing(`${results} a[href="/providers/v1"]`));
});

test("a Program search result without a provider name shows just its name", async () => {
  await openDirectoryPage("/sites?q=Safe", {
    setup: (api) => api.data.programs.push({ ...safeSleeping }),
  });
  assert.equal(
    $(`${results} a[href="/programs/p%2F9"]`).textContent.trim(),
    "Safe Sleeping Drop-In",
  );
});

test("clearing a search on the Managers tab redraws the list once managers load", async () => {
  /** @type {any} */
  let held;
  await openDirectoryPage("/managers?q=Alex", {
    setup: (api) => (held = holdPeople(api)),
  });
  await click("#clear-directory-search");
  held.release();
  await settle();
  assert.ok(
    !missing('[aria-labelledby="managers-title"] a[href="/managers/u1"]'),
  );
});

test("search lists managers by email and Sites by address", async () => {
  await openDirectoryPage("/sites?q=nameless", {
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

test("a 311 save on the mounted directory updates its own catalog", async () => {
  const { catalog } = await openDirectoryPage("/sites");
  await fill('[data-site-311="s1"]', false);
  await click("[data-save-311]");
  assert.equal(
    catalog.sites.find((site) => site.siteId === "s1")
      ?.deliberate311ProductionEnabled,
    false,
  );
});

test("the mounted Site managers list reads and shows its managers", async () => {
  await openDirectoryPage("/managers");
  assert.ok(
    !missing('[aria-labelledby="managers-title"] a[href="/managers/u1"]'),
  );
});

test("a directory mount given a catalog lists that catalog's providers", async () => {
  const catalog = createAdminCatalog();
  catalog.seed({
    providers: [
      { providerId: "v9", name: "Seeded Provider", status: "active" },
    ],
    programs: [],
    oversightOptions: { departments: [], systemsOfCare: [] },
    programManagers: [],
    sites: [],
  });
  await openDirectoryPage("/providers", { catalog });
  assert.ok($("admin-directory-page").textContent.includes("Seeded Provider"));
});

test("a failed Site manager read from a search doesn't show after the managers load", async () => {
  const { page, catalog } = await openDirectoryPage("/sites");
  // <admin-app> reads the Site managers; these stand in for its read failing, then working.
  page.loadManagers = async () => {
    throw new Error("people_unavailable");
  };
  await searchFor("Example");
  assert.equal($(resultStatus).textContent, t("admin.directory.managerError"));
  page.loadManagers = async () =>
    catalog.markManagersLoaded(catalog.managersVersion);
  await routeTo("/managers");
  await routeTo("/sites?q=Example");
  assert.equal(
    $(resultStatus).textContent,
    t("admin.directory.resultCount", { count: 3 }),
  );
});

test("a redraw after the URL moves on still draws the route open() was given", async () => {
  const { page } = await openDirectoryPage("/sites");
  // Unknown paths route to the Sites list, so move to a route this page doesn't show.
  window.history.replaceState({}, "", "/profile");
  page.render();
  assert.ok(!missing("admin-directory-page h1"));
});

test("the Sites list asks in its own dialog, and Discard drops its 311 edits", async () => {
  const { page } = await openDirectoryPage("/sites");
  await fill('[data-site-311="s1"]', false);
  assert.equal(page.hasUnsavedChanges(), true);
  // Back or Forward to another Sites search keeps the edits, so it doesn't ask.
  assert.equal(page.hasUnsavedChanges({ name: "sites" }), false);
  const leave = page.confirmLeave();
  assert.equal($("#site-unsaved-dialog").open, true);
  await click('#site-unsaved-dialog button[value="discard"]');
  assert.equal(await leave, true);
  assert.equal(page.hasUnsavedChanges(), false);
});

test("manager filters narrow the Site manager list", async () => {
  await openDirectoryPage("/managers", {
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

const directoryRows = () =>
  $$('[aria-labelledby="managers-title"] li').map((row) =>
    row.textContent.replace(/\s+/g, " ").trim(),
  );

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
  await openDirectoryPage("/managers", { data });
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
  await openDirectoryPage("/managers", { data });
  // The Site must land on Jordan's own row, not just somewhere in the list.
  assert.match(
    directoryRows().find((row) => row.includes("Jordan Staff")) || "",
    /North Site/,
  );
  assert.ok(!directoryRows().some((row) => row.includes("Former Staff")));
});
