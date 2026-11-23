// @vitest-environment node
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  START_UP_LISTS,
  adminCatalog,
  createAdminCatalog,
} from "./admin-catalog.js";
import { adminApi } from "./services/admin-api.js";

/** A read the test releases, as a slow network would answer. */
function held() {
  /** @type {(value: any) => void} */
  let release = () => {};
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

/**
 * Fake the four start-up reads; returns their mocks to count calls.
 * @param {{ oversight?: () => Promise<any>, programs?: () => Promise<any>, sites?: any[] }} [options]
 */
function fakeReads(options = {}) {
  return {
    providers: vi
      .spyOn(adminApi, "listProviders")
      .mockImplementation(async () => ({
        providers: [{ providerId: "v1", name: "Example Provider" }],
        sites: options.sites,
      })),
    programs: vi
      .spyOn(adminApi, "listPrograms")
      .mockImplementation(
        options.programs ||
          (async () => ({ programs: [{ programId: "p1", name: "Example" }] })),
      ),
    oversight: vi.spyOn(adminApi, "listOversightOptions").mockImplementation(
      options.oversight ||
        (async () => ({
          departments: [{ id: "d1", name: "Example Department" }],
          systemsOfCare: [],
        })),
    ),
    managers: vi
      .spyOn(adminApi, "listCityProgramManagers")
      .mockImplementation(async () => ({
        programManagers: [
          { userId: "m1", firstName: "Casey", lastName: "Doe" },
        ],
      })),
  };
}

// As admin-dom.js does, so a write that changes a stored list in place fails.
beforeEach(() => adminCatalog.freezeLists());

afterEach(() => {
  adminCatalog.freezeLists(false);
  adminCatalog.clear();
});

test("a second ensure() while the lists load shares the first read", async () => {
  const reads = fakeReads();
  await Promise.all([
    adminCatalog.ensure(START_UP_LISTS),
    adminCatalog.ensure(START_UP_LISTS),
  ]);
  assert.equal(reads.providers.mock.calls.length, 1);
  assert.equal(reads.programs.mock.calls.length, 1);
  assert.deepEqual(adminCatalog.programs, [
    { programId: "p1", name: "Example" },
  ]);
});

test("loaded lists aren't read again", async () => {
  const reads = fakeReads();
  await adminCatalog.ensure(START_UP_LISTS);
  await adminCatalog.ensure(["programs"]);
  assert.equal(reads.programs.mock.calls.length, 1);
});

test("after the oversight read fails, the next ensure() reads all four lists again", async () => {
  const reads = fakeReads({
    oversight: async () => {
      throw Object.assign(new Error("oversight_down"), { status: 500 });
    },
  });
  await adminCatalog.ensure(START_UP_LISTS);
  assert.equal(adminCatalog.providers.length, 1);
  assert.deepEqual(adminCatalog.oversightOptions.departments, []);
  await adminCatalog.ensure(START_UP_LISTS);
  assert.equal(reads.providers.mock.calls.length, 2);
  assert.equal(reads.oversight.mock.calls.length, 2);
});

test("a denied oversight read fails the load", async () => {
  fakeReads({
    oversight: async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    },
  });
  await assert.rejects(adminCatalog.ensure(START_UP_LISTS), /forbidden/);
});

test("asking for Sites after the lists loaded reads the directory once", async () => {
  const reads = fakeReads({ sites: [] });
  await adminCatalog.ensure(START_UP_LISTS);
  await adminCatalog.ensure([...START_UP_LISTS, "sites"]);
  await adminCatalog.ensure(["sites"]);
  assert.deepEqual(
    reads.providers.mock.calls.map((args) => args[0]),
    [false, true],
  );
});

test("asking for Sites while a list-only load runs reads the directory after it", async () => {
  const gate = held();
  const reads = fakeReads({ sites: [], programs: () => gate.promise });
  const lists = adminCatalog.ensure(START_UP_LISTS);
  const withSites = adminCatalog.ensure(["sites"]);
  gate.release({ programs: [] });
  await Promise.all([lists, withSites]);
  assert.deepEqual(
    reads.providers.mock.calls.map((args) => args[0]),
    [false, true],
  );
});

test("directory Sites carry the manager's name, active compliance managers and roster", async () => {
  fakeReads({
    sites: [
      {
        items: [
          {
            sk: "#META",
            siteId: "s1",
            oversight: {
              cityProgramManagerId: "m1",
              cityProgramManager: "Old",
            },
          },
          {
            type: "siteComplianceManagerAssignment",
            status: "active",
            managerId: "m1",
          },
          {
            type: "siteComplianceManagerAssignment",
            status: "inactive",
            managerId: "m2",
          },
          {
            type: "managerMembership",
            membershipId: "mm1",
            name: "Blair Sample",
            status: "active",
          },
        ],
      },
      { items: [{ sk: "ASSIGNED_USER#u1" }] },
    ],
  });
  await adminCatalog.ensure(["sites"]);
  assert.equal(adminCatalog.sites.length, 1);
  assert.equal(
    adminCatalog.sites[0].oversight?.cityProgramManager,
    "Casey Doe",
  );
  assert.deepEqual(adminCatalog.sites[0].complianceManagerIds, ["m1"]);
  assert.deepEqual(
    adminCatalog.sites[0].managerMemberships?.map((member) => member.name),
    ["Blair Sample"],
  );
});

test("invalidate() with no name makes the next ensure() read every list again", async () => {
  const reads = fakeReads({ sites: [] });
  await adminCatalog.ensure(["sites"]);
  adminCatalog.invalidate();
  await adminCatalog.ensure(["sites"]);
  assert.equal(reads.providers.mock.calls.length, 2);
});

test("a Sites load still running at invalidate() doesn't count as loaded", async () => {
  const gate = held();
  const reads = fakeReads({ sites: [], programs: () => gate.promise });
  const load = adminCatalog.ensure(["sites"]);
  adminCatalog.invalidate();
  gate.release({ programs: [] });
  await load;
  await adminCatalog.ensure(["sites"]);
  assert.equal(reads.providers.mock.calls.length, 2);
});

test("an ensure() that joins a load started before invalidate() reads again", async () => {
  const gate = held();
  const reads = fakeReads({ sites: [], programs: () => gate.promise });
  const first = adminCatalog.ensure(["sites"]);
  adminCatalog.invalidate();
  const second = adminCatalog.ensure(["sites"]);
  gate.release({ programs: [] });
  await Promise.all([first, second]);
  assert.equal(reads.providers.mock.calls.length, 2);
});

test("invalidate() with no name also makes the manager directory reload", () => {
  adminCatalog.markManagersLoaded(adminCatalog.managersVersion);
  adminCatalog.invalidate();
  assert.equal(adminCatalog.managersLoaded, false);
});

test("a manager read from before clear() doesn't mark the cleared directory loaded", () => {
  const started = adminCatalog.managersVersion;
  adminCatalog.clear();
  adminCatalog.markManagersLoaded(started);
  assert.equal(adminCatalog.managersLoaded, false);
});

test("invalidate('programManagers') marks the list stale until it is read again", () => {
  adminCatalog.invalidate("programManagers");
  assert.equal(adminCatalog.programManagersStale, true);
  adminCatalog.setProgramManagers([]);
  assert.equal(adminCatalog.programManagersStale, true);
  adminCatalog.programManagersReloaded([{ userId: "m1" }]);
  assert.equal(adminCatalog.programManagersStale, false);
  assert.deepEqual(adminCatalog.programManagers, [{ userId: "m1" }]);
});

test("a manager directory read that started before invalidate('managers') doesn't count as loaded", () => {
  const started = adminCatalog.managersVersion;
  adminCatalog.invalidate("managers");
  adminCatalog.markManagersLoaded(started);
  assert.equal(adminCatalog.managersLoaded, false);
  adminCatalog.markManagersLoaded(adminCatalog.managersVersion);
  assert.equal(adminCatalog.managersLoaded, true);
});

test("superseding a manager read keeps the loaded directory", () => {
  adminCatalog.markManagersLoaded(adminCatalog.managersVersion);
  const started = adminCatalog.managersVersion;
  adminCatalog.supersedeManagersLoad();
  assert.notEqual(adminCatalog.managersVersion, started);
  assert.equal(adminCatalog.managersLoaded, true);
});

test("a load still running at clear() doesn't fill the cleared lists", async () => {
  const gate = held();
  fakeReads({ programs: () => gate.promise });
  const load = adminCatalog.ensure(START_UP_LISTS);
  adminCatalog.clear();
  gate.release({ programs: [{ programId: "p1" }] });
  await load;
  assert.deepEqual(adminCatalog.programs, []);
  assert.deepEqual(adminCatalog.providers, []);
});

test("updateProvider merges into a listed provider", () => {
  adminCatalog.seed({
    providers: [{ providerId: "v1", name: "Old", status: "active" }],
  });
  adminCatalog.updateProvider({ providerId: "v1", name: "New" });
  assert.deepEqual(adminCatalog.providers, [
    { providerId: "v1", name: "New", status: "active" },
  ]);
});

test("updateProvider leaves an unlisted provider, such as an inactive one, out", () => {
  adminCatalog.seed({ providers: [{ providerId: "v1", name: "Old" }] });
  adminCatalog.updateProvider({ providerId: "v9", name: "Inactive" });
  assert.deepEqual(adminCatalog.providers, [{ providerId: "v1", name: "Old" }]);
});

test("addProvider lists a new provider", () => {
  adminCatalog.seed({ providers: [{ providerId: "v1", name: "Old" }] });
  adminCatalog.addProvider({ providerId: "v2", name: "Added" });
  assert.deepEqual(
    adminCatalog.providers.map((provider) => provider.providerId),
    ["v1", "v2"],
  );
});

/** Two listed Sites, for the Site change tests. */
function seedSites() {
  adminCatalog.seed({
    sites: [
      { siteId: "s1", name: "One" },
      { siteId: "s2", name: "Two" },
    ],
  });
}

test("updateSite merges an object into the Site with that ID", () => {
  seedSites();
  adminCatalog.updateSite("s1", { name: "First" });
  assert.deepEqual(adminCatalog.sites, [
    { siteId: "s1", name: "First" },
    { siteId: "s2", name: "Two" },
  ]);
});

test("updateSite with a function replaces that Site with its result", () => {
  seedSites();
  adminCatalog.updateSite("s2", (site) => ({ siteId: site.siteId }));
  assert.deepEqual(adminCatalog.sites[1], { siteId: "s2" });
});

test("addSite appends a new Site and merges a listed one", () => {
  seedSites();
  adminCatalog.addSite({ siteId: "s3", name: "Three" });
  adminCatalog.addSite({ siteId: "s1", status: "inactive" });
  assert.deepEqual(adminCatalog.sites, [
    { siteId: "s1", name: "One", status: "inactive" },
    { siteId: "s2", name: "Two" },
    { siteId: "s3", name: "Three" },
  ]);
});

test("updateSites changes every Site", () => {
  seedSites();
  adminCatalog.updateSites((site) => ({ ...site, providerId: "v1" }));
  assert.deepEqual(
    adminCatalog.sites.map((site) => site.providerId),
    ["v1", "v1"],
  );
});

test("removeSite drops the Site with that ID", () => {
  seedSites();
  adminCatalog.removeSite("s1");
  assert.deepEqual(adminCatalog.sites, [{ siteId: "s2", name: "Two" }]);
});

test("addOversightOption keeps the options in name order", () => {
  adminCatalog.seed({
    oversightOptions: {
      departments: [{ name: "Beta" }],
      systemsOfCare: [],
    },
  });
  adminCatalog.addOversightOption("departments", { name: "Alpha" });
  assert.deepEqual(
    adminCatalog.oversightOptions.departments.map((option) => option.name),
    ["Alpha", "Beta"],
  );
});

test("seeded lists count as loaded, so ensure() sends no reads", async () => {
  const reads = fakeReads();
  adminCatalog.seed({
    providers: [],
    programs: [],
    oversightOptions: { departments: [], systemsOfCare: [] },
    programManagers: [],
  });
  await adminCatalog.ensure(START_UP_LISTS);
  assert.equal(reads.providers.mock.calls.length, 0);
});

test("with frozen lists, a direct write throws and the seeded arrays stay writable", () => {
  adminCatalog.freezeLists();
  const programs = [{ programId: "p1" }];
  adminCatalog.seed({ programs, sites: [{ siteId: "s1" }] });
  assert.throws(() => adminCatalog.sites.push({ siteId: "s2" }), TypeError);
  assert.throws(
    () => adminCatalog.oversightOptions.departments.push({}),
    TypeError,
  );
  programs.push({ programId: "p2" });
  assert.equal(adminCatalog.programs.length, 1);
});

test("each created catalog keeps its own lists", () => {
  const first = createAdminCatalog();
  first.seed({ programs: [{ programId: "p1" }] });
  createAdminCatalog().clear();
  assert.deepEqual(first.programs, [{ programId: "p1" }]);
  assert.deepEqual(adminCatalog.programs, []);
});

test("a Program added while the lists load stays listed", async () => {
  const gate = held();
  let programReads = 0;
  const reads = fakeReads({
    programs: async () => {
      programReads++;
      if (programReads === 1) return gate.promise;
      return {
        programs: [
          { programId: "p1", name: "Example" },
          { programId: "p2", name: "New" },
        ],
      };
    },
  });
  const load = adminCatalog.ensure(START_UP_LISTS);
  adminCatalog.addProgram({ programId: "p2", name: "New" });
  gate.release({ programs: [{ programId: "p1", name: "Example" }] });
  await load;
  assert.deepEqual(
    adminCatalog.programs.map((program) => program.programId),
    ["p1", "p2"],
  );
  assert.equal(reads.providers.mock.calls.length, 2);
});

test("a Site edited while the Sites load keeps the edit", async () => {
  const gate = held();
  /** @param {string} name */
  const record = (name) => ({ items: [{ sk: "#META", siteId: "s1", name }] });
  fakeReads();
  let siteReads = 0;
  vi.spyOn(adminApi, "listProviders").mockImplementation(async () => {
    siteReads++;
    if (siteReads === 1) return gate.promise;
    return { providers: [], sites: [record("Renamed")] };
  });
  const load = adminCatalog.ensure(["sites"]);
  adminCatalog.updateSite("s1", { name: "Renamed" });
  gate.release({ providers: [], sites: [record("Old")] });
  await load;
  assert.equal(adminCatalog.sites[0].name, "Renamed");
});

test("a directory record with no Site item is skipped", async () => {
  const reads = fakeReads({
    sites: [
      { items: [{ sk: "ASSIGNED_USER#u1" }] },
      { items: [{ sk: "#META", siteId: "s1", name: "Example Site" }] },
    ],
  });
  reads.managers.mockImplementation(async () => ({
    programManagers: [{ firstName: "Invited", lastName: "Manager" }],
  }));
  await adminCatalog.ensure(["sites"]);
  assert.deepEqual(
    adminCatalog.sites.map((site) => site.siteId),
    ["s1"],
  );
});
