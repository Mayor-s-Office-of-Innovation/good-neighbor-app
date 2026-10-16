import assert from "node:assert/strict";
import test from "node:test";
import { loadManagerDirectory } from "./manager-directory.js";

test("loads every directory record while keeping combined API concurrency at three", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const request = async (kind, id, result) => {
    active++;
    peak = Math.max(peak, active);
    calls.push([kind, id]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return result;
  };
  const programs = Array.from({ length: 8 }, (_, i) => ({
    programId: `p${i}`,
  }));
  const sites = Array.from({ length: 70 }, (_, i) => ({ siteId: `s${i}` }));
  const result = await loadManagerDirectory(
    programs,
    sites,
    {
      getProgram: (id) =>
        request("program", id, { program: { programId: id } }),
      listManagerMemberships: (id) =>
        request("site", id, { memberships: [{ siteId: id }] }),
    },
    3,
  );
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(calls.length, 78);
  assert.deepEqual(
    result.programDetails.map((item) => item.program),
    programs,
  );
  assert.deepEqual(
    result.siteMemberships.map((item) => item.site),
    sites,
  );
  assert.ok(
    result.siteMemberships.every(
      (item) => item.memberships[0].siteId === item.site.siteId,
    ),
  );
});

test("a failed program batch does not start Site requests", async () => {
  let siteRequests = 0;
  await assert.rejects(
    loadManagerDirectory(
      [{ programId: "p1" }],
      [{ siteId: "s1" }],
      {
        getProgram: async () => {
          throw new Error("unavailable");
        },
        listManagerMemberships: async () => {
          siteRequests++;
          return { memberships: [] };
        },
      },
      3,
    ),
    /unavailable/,
  );
  assert.equal(siteRequests, 0);
});
