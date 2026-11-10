import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  mountAdmin,
  routeTo,
  settle,
  tick,
  userEvent,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// main.js has no catalog key for this copy, so tests match its English.

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

test("search matches Sites by oversight names, and clearing it restores the tabs", async () => {
  await mountAdmin("/sites?q=harbor", {
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

test("emptying the search returns to the Site list", async () => {
  await mountAdmin("/sites?q=Example");
  assert.ok(!missing("#directory-results-title"));
  await searchFor("");
  assert.equal(query().has("q"), false);
  assert.ok(!missing(tabs));
});

test("search waits for an input method to finish composing", async () => {
  await mountAdmin("/sites");
  const input = $("#directory-search-input");
  input.dispatchEvent(new window.Event("compositionstart"));
  await searchFor("Quiet");
  await tick(SEARCH_DELAY_MS);
  assert.equal(query().has("q"), false);
  input.dispatchEvent(new window.Event("compositionend"));
  await tick(SEARCH_DELAY_MS);
  assert.equal(query().get("q"), "Quiet");
});

test("submitting the search runs it at once", async () => {
  await mountAdmin("/sites");
  $("#directory-search-input").value = "Example";
  $("#directory-search").dispatchEvent(userEvent("submit"));
  await settle();
  assert.equal(query().get("q"), "Example");
});

test("Site filters update the address and the list", async () => {
  await mountAdmin("/sites", {
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
  await mountAdmin("/sites?manager=Nobody%20Known");
  assert.ok(
    $("admin-app").textContent.includes("No sites match these filters."),
  );
  assert.equal(
    $$('#site-directory-filters wa-option[value="Nobody Known"]').length,
    1,
  );
});

test("a Compliance manager sees their own Sites by default", async () => {
  await mountAdmin("/sites", {
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

test("the Providers tab lists the active providers", async () => {
  await mountAdmin("/providers", {
    setup: (api) =>
      api.data.providers.push({
        providerId: "v3",
        name: "Another Provider",
        status: "active",
      }),
  });
  assert.equal(rows("providers-title").length, 2);
  assert.ok($("admin-app").textContent.includes("2 providers"));
});

test("the Providers tab says when there are no providers", async () => {
  await mountAdmin("/providers", {
    setup: (api) => {
      api.data.providers = [];
    },
  });
  assert.ok(
    $("admin-app").textContent.includes("No providers have been added."),
  );
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

test("Site rows fall back to program and record details", async () => {
  await mountAdmin("/sites", {
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
    await mountAdmin(`/sites?q=${encodeURIComponent(query)}`);
    assert.ok(!missing(`${results} a[href="/managers/u1"]`));
  });

for (const tab of ["managers", "providers"])
  test(`search from the ${tab} tab shows the shared results`, async () => {
    await mountAdmin(`/${tab}?q=Alex`);
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
  await mountAdmin("/sites?q=Safe", {
    setup: (api) => api.data.programs.push({ ...safeSleeping }),
  });
  assert.ok(!missing(`${results} a[href="/programs/p%2F9"]`));
  assert.ok(missing(`${results} a[href="/providers/v1"]`));
});

test("a Program search result without a provider name shows just its name", async () => {
  await mountAdmin("/sites?q=Safe", {
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
