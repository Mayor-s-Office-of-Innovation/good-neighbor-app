import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createAdminCatalog } from "../../admin-catalog.js";
import { adminApi } from "../../services/admin-api.js";
import { createInsightsSession, sessionOf } from "./insights-session.js";

/**
 * @param {{ providers?: () => Promise<any>, managers?: () => Promise<any>, scope?: () => Promise<any> }} replies
 */
function fakeDirectory({
  providers = async () => ({
    providers: [{ providerId: "p1", name: "Harbor Services" }],
  }),
  managers = async () => ({
    programManagers: [{ userId: "u1", firstName: "Alex", lastName: "Rivera" }],
  }),
  scope = async () => ({ groups: {} }),
} = {}) {
  vi.spyOn(adminApi, "listPrograms").mockResolvedValue({ programs: [] });
  vi.spyOn(adminApi, "listOversightOptions").mockResolvedValue({});
  return {
    providers: vi
      .spyOn(adminApi, "listProviders")
      .mockImplementation(providers),
    managers: vi
      .spyOn(adminApi, "listCityProgramManagers")
      .mockImplementation(managers),
    scope: vi
      .spyOn(adminApi, "reportingScopeOptions")
      .mockImplementation(scope),
  };
}

/** @param {number} status */
const refusedWith = (status) =>
  Object.assign(new Error("request_blocked"), { status });

test("names come from the directory and are read once a session", async () => {
  const calls = fakeDirectory();
  const session = createInsightsSession();
  const names = await session.names();
  assert.equal(names.providerId.get("p1"), "Harbor Services");
  assert.equal(names.managerId.get("u1"), "Alex Rivera");
  await session.names();
  assert.equal(calls.providers.mock.calls.length, 1);
  assert.equal(calls.managers.mock.calls.length, 1);
});

test("a name the directory lacks falls back to what it has, then the ID", async () => {
  fakeDirectory({
    providers: async () => ({ providers: [{ providerId: "p2" }] }),
    managers: async () => ({
      programManagers: [{ userId: "u2", name: "Sam Lee" }, { userId: "u3" }],
    }),
  });
  const names = await createInsightsSession().names();
  assert.equal(names.providerId.get("p2"), "p2");
  assert.equal(names.managerId.get("u2"), "Sam Lee");
  assert.equal(names.managerId.get("u3"), "u3");
});

test("a failed directory read leaves IDs, then is read again", async () => {
  let fail = true;
  const calls = fakeDirectory({
    providers: async () => {
      if (fail) throw new Error("network");
      return { providers: [{ providerId: "p1", name: "Harbor Services" }] };
    },
  });
  const session = createInsightsSession();
  const first = await session.namesRead();
  assert.equal(first.complete, false);
  assert.equal(first.names.providerId.size, 0);
  fail = false;
  assert.equal((await session.names()).providerId.get("p1"), "Harbor Services");
  assert.equal(calls.providers.mock.calls.length, 2);
});

for (const status of [401, 403])
  test(`a ${status} on the directory read reaches the page instead of showing IDs`, async () => {
    fakeDirectory({
      providers: async () => {
        throw refusedWith(status);
      },
    });
    const session = createInsightsSession();
    await assert.rejects(session.names(), { status });
    await assert.rejects(session.filterOptions(), { status });
  });

test("a Provider renamed in Manage shows under its new name without a new read", async () => {
  const calls = fakeDirectory();
  const catalog = createAdminCatalog();
  const session = createInsightsSession(catalog);
  assert.equal((await session.names()).providerId.get("p1"), "Harbor Services");
  catalog.updateProvider({ providerId: "p1", name: "Harbor Outreach" });
  assert.equal((await session.names()).providerId.get("p1"), "Harbor Outreach");
  assert.equal(calls.providers.mock.calls.length, 1);
});

test("a reply without its list reads as no names", async () => {
  fakeDirectory({ providers: async () => ({}) });
  const read = await createInsightsSession().namesRead();
  assert.equal(read.complete, true);
  assert.equal(read.names.providerId.size, 0);
});

test("filter options are labelled with names and sorted by label", async () => {
  fakeDirectory({
    managers: async () => ({
      programManagers: [
        { userId: "u1", firstName: "Zoe", lastName: "Park" },
        { userId: "u2", firstName: "Ana", lastName: "Diaz" },
      ],
    }),
    scope: async () => ({
      groups: {
        managerId: [{ value: "u1" }, { value: "u2" }, { value: "u9" }],
        providerId: [{ value: "p1" }],
        department: [{ value: "HSH" }, { value: "DPH" }],
      },
    }),
  });
  const { options } = await createInsightsSession().filterOptions();
  assert.deepEqual(options.managerId, [
    { value: "u2", label: "Ana Diaz" },
    { value: "u9", label: "u9" },
    { value: "u1", label: "Zoe Park" },
  ]);
  assert.deepEqual(options.providerId, [
    { value: "p1", label: "Harbor Services" },
  ]);
  assert.deepEqual(
    options.department.map((o) => o.label),
    ["DPH", "HSH"],
  );
});

test("a scope with no groups offers no options", async () => {
  fakeDirectory({ scope: async () => ({}) });
  const { options } = await createInsightsSession().filterOptions();
  assert.deepEqual(options, { managerId: [], providerId: [], department: [] });
});

test("failed filter options are asked for again on the next open", async () => {
  let fail = true;
  const calls = fakeDirectory({
    scope: async () => {
      if (fail) throw new Error("reporting_failed");
      return { groups: { department: [{ value: "HSH" }] } };
    },
  });
  const session = createInsightsSession();
  await assert.rejects(session.filterOptions(), /reporting_failed/);
  fail = false;
  const { options } = await session.filterOptions();
  assert.deepEqual(options.department, [{ value: "HSH", label: "HSH" }]);
  assert.equal(calls.scope.mock.calls.length, 2);
});

test("options built on a partial name read get names later without reading the scope again", async () => {
  let fail = true;
  const calls = fakeDirectory({
    managers: async () => {
      if (fail) throw new Error("network");
      return { programManagers: [{ userId: "u1", firstName: "Alex" }] };
    },
    scope: async () => ({ groups: { managerId: [{ value: "u1" }] } }),
  });
  const session = createInsightsSession();
  assert.equal(
    (await session.filterOptions()).options.managerId[0].label,
    "u1",
  );
  fail = false;
  assert.equal(
    (await session.filterOptions()).options.managerId[0].label,
    "Alex",
  );
  assert.equal(calls.scope.mock.calls.length, 1);
});

test("every Site's name comes sorted, from the same read as the filters", async () => {
  const calls = fakeDirectory({
    scope: async () => ({
      groups: {},
      sites: [
        { siteId: "s2", name: "Pier Shelter" },
        { siteId: "s1", name: "Harbor House" },
        { siteId: "s3" },
      ],
    }),
  });
  const session = createInsightsSession();
  await session.filterOptions();
  assert.deepEqual(await session.siteOptions(), [
    { value: "s1", label: "Harbor House" },
    { value: "s2", label: "Pier Shelter" },
    { value: "s3", label: "s3" },
  ]);
  await session.siteOptions();
  assert.deepEqual(calls.scope.mock.calls, [[{ include: "sites" }]]);
});

test("a reply from a newer snapshot reads the Sites and filter groups again", async () => {
  let snapshotId = "snap-1";
  const calls = fakeDirectory({
    scope: async () => ({
      meta: { snapshotId },
      groups: {},
      sites: [{ siteId: snapshotId === "snap-1" ? "s1" : "s2" }],
    }),
  });
  const session = createInsightsSession();
  await session.siteOptions();
  assert.equal(session.sawSnapshot("snap-1"), false);
  assert.deepEqual(
    (await session.siteOptions()).map((o) => o.value),
    ["s1"],
  );
  snapshotId = "snap-2";
  assert.equal(session.sawSnapshot("snap-2"), true);
  assert.deepEqual(
    (await session.siteOptions()).map((o) => o.value),
    ["s2"],
  );
  assert.equal(calls.scope.mock.calls.length, 2);
});

test("a failed Site list is asked for again", async () => {
  let fail = true;
  const calls = fakeDirectory({
    scope: async () => {
      if (fail) throw new Error("reporting_failed");
      return { sites: [{ siteId: "s1", name: "Harbor House" }] };
    },
  });
  const session = createInsightsSession();
  await assert.rejects(session.siteOptions(), /reporting_failed/);
  fail = false;
  assert.equal((await session.siteOptions()).length, 1);
  assert.equal(calls.scope.mock.calls.length, 2);
});

test("pages share their dashboard's session; a page outside one gets its own", () => {
  const page = {};
  const inside = /** @type {any} */ ({ closest: () => page });
  assert.equal(sessionOf(inside), sessionOf(inside));
  const outside = /** @type {any} */ ({ closest: () => null });
  assert.notEqual(sessionOf(outside), sessionOf(outside));
});

test("a dashboard's session reads names from the dashboard's own lists", async () => {
  const calls = fakeDirectory();
  const catalog = createAdminCatalog();
  catalog.seed({
    providers: [{ providerId: "p1", name: "Seeded Provider" }],
    programs: [],
    oversightOptions: { departments: [], systemsOfCare: [] },
    programManagers: [],
  });
  const page = { catalog };
  const session = sessionOf(/** @type {any} */ ({ closest: () => page }));
  assert.equal((await session.names()).providerId.get("p1"), "Seeded Provider");
  assert.equal(calls.providers.mock.calls.length, 0);
});

test("Program options share the scope read and fall back to IDs until the names load", async () => {
  let fail = true;
  const calls = fakeDirectory({
    scope: async () => ({ groups: { programId: [{ value: "g1" }] } }),
  });
  const programs = vi
    .spyOn(adminApi, "listPrograms")
    .mockImplementation(async () => {
      if (fail) throw new Error("network");
      return { programs: [{ programId: "g1", name: "Safe Spaces" }] };
    });
  const session = createInsightsSession();
  await session.filterOptions();
  assert.equal((await session.programOptions())[0].label, "g1");
  fail = false;
  assert.equal((await session.programOptions())[0].label, "Safe Spaces");
  const reads = programs.mock.calls.length;
  await session.programOptions();
  assert.equal(programs.mock.calls.length, reads);
  assert.equal(calls.scope.mock.calls.length, 1);
});
