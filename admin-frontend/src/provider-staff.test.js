import test from "node:test";
import assert from "node:assert/strict";
import { loadProviderStaff } from "./provider-staff.js";

test("loads active provider and sibling-program staff without crossing provider boundaries", async () => {
  const requested = [];
  const staff = await loadProviderStaff(
    "one",
    [
      { programId: "sibling", providerId: "one", status: "active" },
      { programId: "inactive", providerId: "one", status: "inactive" },
      { programId: "other", providerId: "two", status: "active" },
    ],
    {
      listProviderManagers: async (id) => {
        assert.equal(id, "one");
        return {
          managers: [
            { membershipId: "provider-staff", status: "active" },
            { membershipId: "archived", status: "inactive" },
          ],
        };
      },
      getProgram: async (id) => {
        requested.push(id);
        return {
          users: [
            { userId: "program-staff", status: "active" },
            { userId: "archived", status: "inactive" },
          ],
        };
      },
    },
  );
  assert.deepEqual(requested, ["sibling"]);
  assert.deepEqual(
    staff.map((item) => item.reference),
    [
      { providerManagerId: "provider-staff" },
      { programId: "sibling", userId: "program-staff" },
    ],
  );
});

test("does not silently offer an incomplete staff list when a source fails", async () => {
  await assert.rejects(
    loadProviderStaff("one", [], {
      listProviderManagers: async () => {
        throw new Error("unavailable");
      },
    }),
    /unavailable/,
  );
});
