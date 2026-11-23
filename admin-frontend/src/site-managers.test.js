// @vitest-environment node
import assert from "node:assert/strict";
import { test } from "vitest";
import { siteManagerRoster } from "./site-managers.js";

test("combines legacy assignments and memberships without duplicating a person", () => {
  const roster = siteManagerRoster(
    [
      {
        userId: "one",
        firstName: "First",
        lastName: "Manager",
        status: "active",
      },
      {
        userId: "two",
        firstName: "Second",
        lastName: "Manager",
        status: "active",
      },
    ],
    [
      {
        userId: "one",
        membershipId: "m1",
        status: "active",
        name: "Old Name",
        email: "old@example.org",
      },
    ],
    [
      {
        userId: "one",
        firstName: "Updated",
        lastName: "Name",
        email: "new@example.org",
      },
    ],
  );
  assert.equal(roster.length, 2);
  assert.equal(roster[0].membershipId, "m1");
  assert.equal(roster[0].name, "Updated Name");
  assert.equal(roster[0].email, "new@example.org");
  assert.equal(roster[1].legacyAssignment, true);
  assert.equal(roster[1].membershipId, "legacy:two");
});

test("matches older email-only memberships to current program staff", () => {
  const roster = siteManagerRoster(
    [{ userId: "u1", email: "sam@example.org" }],
    [{ membershipId: "m1", email: "sam@example.org", status: "active" }],
    [
      {
        userId: "u1",
        email: "sam@example.org",
        firstName: "Sam",
        lastName: "Lee",
      },
    ],
  );
  assert.equal(roster.length, 1);
  assert.equal(roster[0].userId, "u1");
});
