import assert from "node:assert/strict";
import test from "node:test";
import { visibleRecords } from "./record-navigation.js";

const records = {
  provider: { providerId: "p1" },
  program: { programId: "g1" },
  site: { siteId: "s1" },
  siteManager: { userId: "u1" },
};
const routes = [
  { name: "provider", id: "p1", key: "provider" },
  { name: "program", id: "g1", key: "program" },
  { name: "site", id: "s1", key: "site" },
  { name: "manager", id: "u1", key: "siteManager" },
];

test("each record route renders only its record even when every other view is stale", () => {
  for (const route of routes) {
    const selected = visibleRecords(records, route);
    assert.equal(selected[route.key], records[route.key]);
    assert.equal(Object.values(selected).filter(Boolean).length, 1);
  }
});

test("another record's late response cannot appear on the current record route", () => {
  for (const route of routes) {
    assert.ok(
      Object.values(
        visibleRecords(records, { ...route, id: "different" }),
      ).every((value) => value === null),
    );
  }
});

test("directory, new-record, and import routes never retain an old detail view", () => {
  for (const name of [
    "sites",
    "programs",
    "providers",
    "managers",
    "site-new",
    "provider-new",
    "program-new",
    "manager-new",
    "site-import",
  ]) {
    assert.ok(
      Object.values(visibleRecords(records, { name })).every(
        (value) => value === null,
      ),
    );
  }
});
