import test from "node:test";
import assert from "node:assert/strict";
import { peopleDirectory } from "./people-directory.js";

test("keeps same-email people separate and site assignments independent of primary affiliation", () => {
  const people = [
    {
      personId: "one",
      siteManager: true,
      email: "shared@example.org",
      primaryProgramId: "new",
      sources: [{ pk: "PROGRAM#old", sk: "USER#legacy" }],
    },
    {
      personId: "two",
      siteManager: true,
      email: "shared@example.org",
      sources: [],
    },
  ];
  const membership = {
    personId: "one",
    siteId: "s",
    programId: "old",
    userId: "legacy",
  };
  const rows = peopleDirectory(
    people,
    [membership],
    [{ programId: "new", name: "New" }],
    [],
    [{ userId: "legacy" }],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].programName, "New");
  assert.deepEqual(rows[0].legacyUserIds, ["legacy"]);
  assert.deepEqual(rows[0].assignedSites, [membership]);
  assert.deepEqual(rows[1].assignedSites, []);
});
