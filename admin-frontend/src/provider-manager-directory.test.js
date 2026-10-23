import test from "node:test";
import assert from "node:assert/strict";
import {
  loadProviderManagerDirectory,
  providerManagerPath,
  revokeProviderDevices,
  removeProviderManagerAccess,
} from "./provider-manager-directory.js";

test("directory retains unlinked records and provider context, sorted by name", async () => {
  const rows = await loadProviderManagerDirectory(
    [{ providerId: "p1", name: "Provider" }],
    {
      listProviderManagers: async () => ({
        managers: [
          {
            membershipId: "2",
            firstName: "Zoe",
            lastName: "Lee",
            status: "active",
          },
          {
            membershipId: "1",
            firstName: "Amy",
            lastName: "Lee",
            status: "inactive",
          },
        ],
      }),
    },
  );
  assert.deepEqual(
    rows.map((row) => row.membershipId),
    ["1", "2"],
  );
  assert.equal(rows[0].providerName, "Provider");
  assert.equal(rows[0].status, "inactive");
  assert.equal(
    providerManagerPath("a/b", "c d"),
    "/provider-managers/a%2Fb/c%20d",
  );
});

test("provider-wide device revocation keeps manager assignments intact", async () => {
  const revoked = [];
  const api = {
    listProviderManagers: async () => ({
      enrollments: [
        { enrollmentId: "a", membershipId: "m1", status: "active" },
        { enrollmentId: "b", membershipId: "m2", status: "partially_revoked" },
        { enrollmentId: "c", status: "revoked" },
      ],
    }),
    revokeProviderManagerEnrollment: async (provider, id) =>
      revoked.push([provider, id]),
    deactivateProviderManager: () => assert.fail("must keep assignments"),
  };
  assert.equal(await revokeProviderDevices(api, "p"), 2);
  assert.deepEqual(revoked, [
    ["p", "a"],
    ["p", "b"],
  ]);
});

test("individual removal retains the record and revokes only its devices after unlinking", async () => {
  const calls = [];
  const api = {
    deactivateProviderManager: async (p, m) => calls.push(["unlink", p, m]),
    listProviderManagers: async () => ({
      enrollments: [
        { enrollmentId: "a", membershipId: "m1", status: "active" },
        { enrollmentId: "b", membershipId: "m2", status: "active" },
      ],
    }),
    revokeProviderManagerEnrollment: async (p, id) =>
      calls.push(["revoke", p, id]),
  };
  await removeProviderManagerAccess(api, "p", "m1");
  assert.deepEqual(calls, [
    ["unlink", "p", "m1"],
    ["revoke", "p", "a"],
  ]);
});

test("retry reloads remaining devices and does not swallow real failures", async () => {
  let remaining = [
    { enrollmentId: "a", status: "active" },
    { enrollmentId: "b", status: "active" },
  ];
  let fail = true;
  const api = {
    listProviderManagers: async () => ({ enrollments: remaining }),
    revokeProviderManagerEnrollment: async (p, id) => {
      if (id === "b" && fail) throw new Error("network");
      remaining = remaining.filter((row) => row.enrollmentId !== id);
    },
  };
  await assert.rejects(revokeProviderDevices(api, "p"), /network/);
  assert.deepEqual(
    remaining.map((row) => row.enrollmentId),
    ["b"],
  );
  fail = false;
  assert.equal(await revokeProviderDevices(api, "p"), 1);
});

test("manager detail routes retain provider and membership identity", async () => {
  const { currentRoute } = await import("./router.js");
  const old = globalThis.window;
  try {
    globalThis.window = { location: { pathname: "/provider-managers/p1/m1" } };
    assert.deepEqual(currentRoute(), {
      name: "provider-manager",
      id: "p1",
      membershipId: "m1",
    });
    window.location.pathname = "/provider-managers";
    assert.deepEqual(currentRoute(), { name: "provider-managers", id: "" });
  } finally {
    globalThis.window = old;
  }
});

test("transfer shows the current assignment without combining unrelated people", async () => {
  const rows = await loadProviderManagerDirectory(
    [{ providerId: "old" }, { providerId: "new" }],
    {
      listProviderManagers: async (id) => ({
        managers:
          id === "old"
            ? [
                {
                  personId: "one",
                  membershipId: "old",
                  status: "inactive",
                  email: "shared@example.org",
                },
                {
                  personId: "two",
                  membershipId: "separate",
                  status: "active",
                  email: "shared@example.org",
                },
              ]
            : [{ personId: "one", membershipId: "new", status: "active" }],
      }),
    },
  );
  assert.deepEqual(rows.map((r) => r.membershipId).sort(), ["new", "separate"]);
});
