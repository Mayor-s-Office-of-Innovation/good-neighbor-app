import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  mountPage,
  routeTo,
  settle,
  tick,
  userEvent,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { adminCatalog, createAdminCatalog } from "./admin-catalog.js";
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
 * <admin-directory-page> alone, without <admin-app>, following the directory tabs. Site
 * managers still live in <admin-app>, so app-directory-managers.test.js tests them.
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
    ],
    sites: true,
    ...options,
  });

/** Type into the search box and wait out its debounce. @param {string} value */
async function searchFor(value) {
  await fill("#directory-search-input", value);
  await tick(SEARCH_DELAY_MS);
}

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

test("a 311 save on the mounted directory updates its own catalog, not adminCatalog", async () => {
  const { catalog } = await openDirectoryPage("/sites");
  await fill('[data-site-311="s1"]', false);
  await click("[data-save-311]");
  assert.equal(
    catalog.sites.find((site) => site.siteId === "s1")
      ?.deliberate311ProductionEnabled,
    false,
  );
  assert.deepEqual(adminCatalog.sites, []);
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
