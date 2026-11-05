import assert from "node:assert/strict";
import { test, vi } from "vitest";
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

test("names come from the directory and are read once a session", async () => {
  const calls = fakeDirectory();
  const session = createInsightsSession();
  const names = await session.names();
  assert.equal(names.providerId.get("p1"), "Harbor Services");
  assert.equal(names.managerId.get("u1"), "Alex Rivera");
  await session.names();
  assert.equal(calls.providers.mock.calls.length, 1);
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
  assert.equal(first.names.managerId.get("u1"), "Alex Rivera");
  fail = false;
  assert.equal((await session.names()).providerId.get("p1"), "Harbor Services");
  assert.equal(calls.providers.mock.calls.length, 2);
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

test("options built on a partial name read are built again next time", async () => {
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
  assert.equal(calls.scope.mock.calls.length, 2);
  await session.filterOptions();
  assert.equal(calls.scope.mock.calls.length, 2);
});

test("pages share their dashboard's session; a page outside one gets its own", () => {
  const page = {};
  const inside = /** @type {any} */ ({ closest: () => page });
  assert.equal(sessionOf(inside), sessionOf(inside));
  const outside = /** @type {any} */ ({ closest: () => null });
  assert.notEqual(sessionOf(outside), sessionOf(outside));
});
