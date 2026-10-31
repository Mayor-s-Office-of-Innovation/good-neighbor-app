import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { siteManagerRoster } from "./site-managers.js";
import { upsertRecord } from "./save-feedback.js";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
function fixture(api, path = "/sites/s", selected = ["s"]) {
  const location = { pathname: path, search: "" };
  const context = {
    HTMLElement: class {},
    getAdminConfig: () => ({}),
    location,
    URLSearchParams,
    window: { location, history: { replaceState() {} } },
    currentRoute: () => ({
      name: location.pathname === "/administrators" ? "administrators" : "site",
      id: "s",
    }),
    AbortController,
    queueMicrotask: () => {},
    adminApi: api,
    siteManagerRoster,
    upsertRecord,
    FormData: class {
      getAll() {
        return selected;
      }
    },
    formValue: () => "value",
  };
  const Subject = vm.runInNewContext(
    `(${source.slice(source.indexOf("class AdminApp"), source.indexOf("\ncustomElements.define"))})`,
    context,
  );
  const app = new Subject();
  app.render = () => {};
  app.querySelector = () => null;
  return { app, location };
}
function siteApi() {
  const calls = [];
  const api = Object.fromEntries(
    [
      "listPeople",
      "listManagerMemberships",
      "listManagerGrants",
      "listDevices",
      "listSiteTerms",
    ].map((name) => [
      name,
      async () => {
        calls.push(name);
        return {};
      },
    ]),
  );
  api.getSite = async (_id, _roster, view) => {
    calls.push(view);
    return {
      items: [{ sk: "#META", siteId: "s" }],
      permissions: { canEdit: false },
    };
  };
  return { api, calls };
}
test("opening Manage users loads session and users without any entity directories", async () => {
  const calls = [];
  const { app } = fixture(
    {
      getSession: async () => {
        calls.push("session");
        return {
          role: "compliance-supervisor",
          capabilities: { manageAdminUsers: true },
        };
      },
      listAdminUsers: async () => {
        calls.push("users");
        return { users: [{ username: "one" }] };
      },
    },
    "/administrators",
  );
  await app.bootstrap();
  assert.deepEqual(calls, ["session", "users"]);
  assert.equal(app.state.adminUsers.length, 1);
});
test("site sections load only their data and reuse a recently loaded section", async () => {
  const { api, calls } = siteApi();
  const { app, location } = fixture(api);
  await app.openSite("s", false, false);
  assert.deepEqual(calls, ["details", "listPeople"]);
  assert.equal(app.state.siteCanEdit, false);
  location.search = "?section=oversight";
  await app.openSite("s", false, false);
  assert.deepEqual(calls.slice(2), ["oversight"]);
  location.search = "";
  await app.openSite("s", false, false);
  assert.equal(calls.length, 3);
  location.search = "?section=access";
  await app.openSite("s", false, false);
  assert.deepEqual(calls.slice(3), [
    "access",
    "listManagerMemberships",
    "listManagerGrants",
    "listDevices",
    "listPeople",
  ]);
});
test("a late site response cannot overwrite another route or render its draft", async () => {
  let release;
  const { api } = siteApi();
  api.getSite = () =>
    new Promise((r) => {
      release = r;
    });
  const { app, location } = fixture(api);
  let renders = 0;
  app.render = () => renders++;
  const pending = app.openSite("s", false);
  location.pathname = "/administrators";
  release({ items: [{ sk: "#META", siteId: "s" }] });
  await pending;
  assert.equal(app.state.site, null);
  assert.equal(renders, 0);
});
test("editing a manager name preserves assignments without reading or rebuilding directories", async () => {
  const person = { personId: "p", firstName: "Updated" };
  const { app } = fixture(
    { updatePerson: async () => ({ person }) },
    "/managers/p",
  );
  const current = {
    personId: "p",
    userId: "p",
    assignedSites: [{ siteId: "s", membershipId: "m", personId: "p" }],
  };
  app.state.capabilities.createEntities = true;
  app.state.siteManagers = [current];
  app.state.sites = [
    { siteId: "s", managerMemberships: current.assignedSites },
  ];
  await app.persistPersonManager({ dataset: {} }, current, {
    changed() {},
    success() {},
  });
  assert.equal(app.state.siteManager.firstName, "Updated");
  assert.equal(app.state.siteManager.assignedSites.length, 1);
});
test("a failed assignment retry retains confirmed assignments and does not repeat successful writes", async () => {
  const person = { personId: "p" };
  const writes = [];
  let fail = true;
  let creates = 0;
  const { app } = fixture(
    {
      createPerson: async () => {
        creates++;
        return { person };
      },
      updatePerson: async () => ({ person }),
      listManagerMemberships: async () => ({ memberships: [] }),
      assignPersonToSite: async (siteId) => {
        writes.push(siteId);
        if (siteId === "s2" && fail) throw Error("assignment failed");
        return { membership: { membershipId: siteId, personId: "p" } };
      },
    },
    "/managers/new",
    ["s", "s2"],
  );
  app.state.capabilities.createEntities = true;
  app.state.sites = [{ siteId: "s" }, { siteId: "s2" }];
  const form = { dataset: {} };
  const feedback = { changed() {}, success() {} };
  await assert.rejects(
    app.persistPersonManager(form, null, feedback),
    /assignment failed/,
  );
  fail = false;
  await app.persistPersonManager(form, null, feedback);
  assert.deepEqual(writes, ["s", "s2", "s2"]);
  assert.equal(creates, 1);
  assert.equal(app.state.siteManager.assignedSites.length, 2);
});

test("optional oversight failures preserve directory data and retry on the next load", async () => {
  let fail = true;
  const { app } = fixture({
    listProviders: async () => ({
      providers: [{ providerId: "p" }],
      sites: [],
    }),
    listPrograms: async () => ({ programs: [] }),
    listCityProgramManagers: async () => ({ programManagers: [] }),
    listOversightOptions: async () => {
      if (fail) throw Error("unavailable");
      return { departments: [{ name: "Recovered" }], systemsOfCare: [] };
    },
  });
  app.state.oversightOptions = {
    departments: [{ name: "Existing" }],
    systemsOfCare: [],
  };
  await app.loadDirectory(false);
  assert.equal(app.state.providers.length, 1);
  assert.equal(app.state.oversightOptions.departments[0].name, "Existing");
  assert.equal(app.catalogsLoaded, false);
  fail = false;
  await app.loadDirectory(false);
  assert.equal(app.state.oversightOptions.departments[0].name, "Recovered");
  assert.equal(app.catalogsLoaded, true);
});

test("letter loads follow navigation and ignore stale responses even after returning to a site", async () => {
  const pending = [];
  const { app, location } = fixture({
    getSiteLetters: (id) =>
      new Promise((resolve) => pending.push({ id, resolve })),
  });
  app.renderLetterStatus = () => {};
  app.state.site = { siteId: "a" };
  app.siteLoadGeneration = 1;
  const first = app.loadSiteLetters("a");
  app.state.site = { siteId: "b" };
  app.siteLoadGeneration++;
  location.pathname = "/sites/b";
  const second = app.loadSiteLetters("b");
  assert.equal(pending.length, 2);
  pending[0].resolve({ items: [{ sk: "#META", siteId: "a" }] });
  await first;
  assert.equal(app.lettersLoading.siteId, "b");
  app.state.site = { siteId: "a" };
  app.siteLoadGeneration++;
  location.pathname = "/sites/a";
  const third = app.loadSiteLetters("a");
  pending[2].resolve({
    items: [{ sk: "#META", siteId: "a", name: "current" }],
  });
  await third;
  pending[1].resolve({
    items: [{ sk: "#META", siteId: "b", name: "obsolete" }],
  });
  await second;
  assert.equal(app.state.site.name, "current");
});

test("letter pagination retains uncertainty from history and jobs; fresh history can clear it", async () => {
  let items = [{ type: "complianceLetterEmail", deliveryState: "uncertain" }];
  const { app } = fixture({ getSiteLetters: async () => ({ items }) });
  app.state.site = { siteId: "s" };
  app.renderLetterStatus = () => {};
  await app.loadSiteLetters("s");
  items = [{ type: "complianceLetterEmail", deliveryState: "sent" }];
  await app.loadSiteLetters("s", true);
  assert.equal(app.state.letterEmailHistory.length, 2);
  assert.equal(app.state.letterEmailUncertain, true);
  await app.loadSiteLetters("s");
  assert.equal(app.state.letterEmailUncertain, false);
  items = [{ type: "complianceLetterJob", deliveryState: "uncertain" }];
  await app.loadSiteLetters("s");
  assert.equal(app.state.letterEmailUncertain, true);
});

test("refreshing compliance reloads links only when Letters is expanded", async () => {
  const { api } = siteApi();
  const { app, location } = fixture(api);
  location.search = "?section=compliance";
  app.state.site = { siteId: "s" };
  app.state.expandedLettersSiteId = "s";
  const loads = [];
  app.loadSiteLetters = async (id) => loads.push(id);
  await app.openSite("s", false);
  assert.deepEqual(loads, ["s"]);
  app.state.expandedLettersSiteId = null;
  await app.openSite("s", false);
  assert.deepEqual(loads, ["s"]);
});

for (const [status, message, succeeds] of [
  [404, "manager_membership_not_found", true],
  [404, "site_not_found", false],
  [403, "manager_membership_not_found", false],
  [500, "failed", false],
]) {
  test(`manager removal handles ${status} ${message} without hiding other failures`, async () => {
    const person = { personId: "p", name: "Person" };
    const { app } = fixture(
      {
        updatePerson: async () => ({ person }),
        deactivateManagerMembership: async () => {
          throw Object.assign(Error(message), { status });
        },
      },
      "/managers/p",
      [],
    );
    app.state.capabilities.createEntities = true;
    const current = {
      ...person,
      assignedSites: [{ siteId: "s", membershipId: "m" }],
    };
    const form = { dataset: {} };
    const save = app.persistPersonManager(form, current, {
      changed() {},
      success() {},
    });
    if (succeeds) {
      await save;
      assert.equal(app.state.siteManager.assignedSites.length, 0);
      assert.equal(form.confirmedAssignments.size, 0);
    } else {
      await assert.rejects(save, new RegExp(message));
      assert.equal(form.confirmedAssignments.size, 1);
    }
  });
}

test("App settings loads only metadata and preserves cached Site assignments", async () => {
  const { api, calls } = siteApi();
  const { app, location } = fixture(api);
  app.state.capabilities.createEntities = true;
  await app.openSite("s", false, false);
  app.state.assignedComplianceManagers = [{ managerId: "synthetic-manager" }];
  location.search = "?section=settings";
  await app.openSite("s", false, false);
  assert.deepEqual(calls, ["details", "listPeople", "settings"]);
  assert.equal(
    app.state.assignedComplianceManagers[0].managerId,
    "synthetic-manager",
  );
  location.search = "";
  await app.openSite("s", false, false);
  assert.equal(calls.length, 3);
  assert.equal(
    app.state.assignedComplianceManagers[0].managerId,
    "synthetic-manager",
  );
});
