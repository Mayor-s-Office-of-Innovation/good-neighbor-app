import assert from "node:assert/strict";
import test from "node:test";
import { loadProgramStaff, primaryProgramStaffId } from "./program-staff.js";

test("includes unassigned staff and names distinct active sites across both assignment types", async () => {
  const users = [
    { userId: "unassigned", firstName: "Amy", lastName: "Lee" },
    {
      userId: "assigned",
      firstName: "Sam",
      lastName: "Lee",
      email: "sam@example.org",
    },
    { userId: "inactive", status: "inactive" },
  ];
  const program = {
    programId: "p1",
    users,
    sites: ["one", "two", "inactive", "other"].map((siteId) => ({ siteId })),
  };
  const roster = await loadProgramStaff(
    program,
    {
      getSite: async (siteId) => ({
        items: [
          {
            sk: "#META",
            siteId,
            name: siteId,
            leadProgramId: siteId === "other" ? "p2" : "p1",
            status: siteId === "inactive" ? "inactive" : "active",
          },
          { type: "siteUserAssignment", userId: "assigned", status: "active" },
          { type: "managerMembership", userId: "assigned", status: "active" },
          {
            type: "managerMembership",
            userId: "unassigned",
            status: "inactive",
          },
        ],
      }),
    },
    3,
  );
  assert.equal(roster.length, 2);
  assert.deepEqual(roster[0].assignedSites, []);
  assert.deepEqual(
    roster[1].assignedSites.map((site) => site.name),
    ["one", "two"],
  );
});

test("recognizes legacy email memberships but does not match blank emails", async () => {
  const roster = await loadProgramStaff(
    {
      programId: "p1",
      sites: [{ siteId: "s1" }],
      users: [{ userId: "u1", email: "SAM@example.org" }, { userId: "u2" }],
    },
    {
      getSite: async () => ({
        items: [
          { sk: "#META", leadProgramId: "p1", name: "Mission" },
          {
            type: "managerMembership",
            email: "sam@example.org",
            status: "active",
          },
          { type: "managerMembership", email: "", status: "active" },
        ],
      }),
    },
    3,
  );
  assert.equal(
    roster.find((user) => user.userId === "u1").assignedSites.length,
    1,
  );
  assert.equal(
    roster.find((user) => user.userId === "u2").assignedSites.length,
    0,
  );
});

test("primary staff uses the saved ID or a unique active legacy email match", () => {
  const users = [{ userId: "one", email: "sam@example.org" }];
  assert.equal(
    primaryProgramStaffId({ primaryContactUserId: "two", users }),
    "two",
  );
  assert.equal(
    primaryProgramStaffId({ contact: { email: "SAM@example.org" }, users }),
    "one",
  );
  assert.equal(
    primaryProgramStaffId({
      contact: { email: "sam@example.org" },
      users: [...users, { userId: "two", email: "sam@example.org" }],
    }),
    "",
  );
});
