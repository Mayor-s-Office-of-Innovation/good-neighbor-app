import { beforeEach, expect, it, vi } from "vitest";
import { ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { migrateAssignmentPointers } from "./migrate-assignment-pointers.mjs";

beforeEach(() => vi.stubEnv("DYNAMO_TABLE", "test"));

/** @param {string} site @param {string} user @param {string} [program] */
const assignment = (site, user, program = "p") => ({
  pk: `SITE#${site}`,
  sk: `ASSIGNED_USER#${user}`,
  programId: program,
  userId: user,
  siteId: site,
});
/** @param {string} site @param {string} user @param {string} [program] */
const pointer = (site, user, program = "p") => ({
  pk: `PROGRAM#${program}`,
  sk: `USER_SITE#${user}#${site}`,
  programId: program,
  userId: user,
  siteId: site,
});

/** Two scan pages, so pagination is covered. @param {any[]} rows */
function fixture(rows) {
  const half = Math.ceil(rows.length / 2);
  const send = vi.fn(async (/** @type {any} */ command) => {
    if (command instanceof ScanCommand)
      return command.input.ExclusiveStartKey
        ? { Items: rows.slice(half) }
        : {
            Items: rows.slice(0, half),
            LastEvaluatedKey: { pk: "x", sk: "y" },
          };
    return {};
  });
  return {
    client: { send },
    /** @returns {any[]} every transaction item written */
    written: () =>
      send.mock.calls
        .filter(([command]) => command instanceof TransactWriteCommand)
        .flatMap(([command]) => command.input.TransactItems),
  };
}

const rows = () => [
  assignment("a", "u1"),
  assignment("b", "u1"),
  pointer("a", "u1"),
  // A pointer whose assignment is gone.
  pointer("gone", "u2"),
  // Legacy row with no program id: can't be pointed at; reported, not guessed.
  { pk: "SITE#c", sk: "ASSIGNED_USER#u3" },
  { pk: "SITE#a", sk: "#META" },
];

it("reports missing and orphaned pointers without writing in dry-run mode", async () => {
  const f = fixture(rows());
  const report = await migrateAssignmentPointers({ client: f.client });
  expect(report).toEqual({
    mode: "dry-run",
    assignments: 3,
    pointers: 2,
    missing: 1,
    orphaned: 1,
    unlinkable: 1,
  });
  expect(f.written()).toEqual([]);
});

it("writes missing pointers and removes orphaned ones with --apply", async () => {
  const f = fixture(rows());
  const report = await migrateAssignmentPointers({
    apply: true,
    client: f.client,
    now: "2026-11-25T00:00:00.000Z",
  });
  expect(report).toMatchObject({ mode: "apply", missing: 1, orphaned: 1 });
  expect(f.written()).toEqual([
    {
      Put: {
        TableName: "test",
        Item: {
          pk: "PROGRAM#p",
          sk: "USER_SITE#u1#b",
          type: "programUserSitePointer",
          programId: "p",
          userId: "u1",
          siteId: "b",
          createdAt: "2026-11-25T00:00:00.000Z",
        },
      },
    },
    {
      Delete: {
        TableName: "test",
        Key: { pk: "PROGRAM#p", sk: "USER_SITE#u2#gone" },
      },
    },
  ]);
});

it("does nothing when every assignment already has its pointer", async () => {
  const f = fixture([assignment("a", "u1"), pointer("a", "u1")]);
  const report = await migrateAssignmentPointers({
    apply: true,
    client: f.client,
  });
  expect(report).toMatchObject({ missing: 0, orphaned: 0 });
  expect(f.written()).toEqual([]);
});

it("writes in transactions of at most 25 items", async () => {
  const many = Array.from({ length: 30 }, (_, i) => assignment(`s${i}`, "u1"));
  const f = fixture(many);
  await migrateAssignmentPointers({ apply: true, client: f.client });
  const sizes = f.client.send.mock.calls
    .filter(([command]) => command instanceof TransactWriteCommand)
    .map(([command]) => command.input.TransactItems.length);
  expect(sizes).toEqual([25, 5]);
});
