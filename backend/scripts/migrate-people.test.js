import { beforeEach, expect, it, vi } from "vitest";
import { ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { migratePeople } from "./migrate-people.mjs";
beforeEach(() => vi.stubEnv("DYNAMO_TABLE", "test"));
const contact = (id, extra = {}) => ({
  pk: "PROGRAM#p",
  sk: `USER#${id}`,
  programId: "p",
  userId: id,
  email: "same@example.org",
  ...extra,
});
const copy = (id, from) =>
  contact(id, { staffSource: { programId: "p", userId: from } });
function fixture(rows, write = async () => ({})) {
  const send = vi.fn(async (command) =>
    command instanceof ScanCommand ? { Items: rows } : write(command),
  );
  return {
    client: { send },
    writes: () =>
      send.mock.calls
        .filter(([c]) => c instanceof TransactWriteCommand)
        .map(([c]) => c.input.TransactItems),
  };
}
it("groups explicit chains and site projections atomically, never by matching email", async () => {
  const f = fixture([
    copy("c", "b"),
    copy("b", "a"),
    contact("a"),
    contact("unrelated"),
    { pk: "SITE#s", sk: "ASSIGNED_USER#c", programId: "p", userId: "c" },
  ]);
  const report = await migratePeople({ apply: true, client: f.client });
  expect(report).toMatchObject({ people: 2, conflicts: [] });
  const writes = f.writes();
  expect(writes[0]).toHaveLength(5);
  expect(
    new Set(
      writes[0]
        .slice(1)
        .map((i) => i.Update.ExpressionAttributeValues[":person"]),
    ).size,
  ).toBe(1);
  expect(writes[0][0].Put.Item.personId).not.toBe(
    writes[1][0].Put.Item.personId,
  );
});
it("reuses an existing source person with revision protection and deduplicated sources", async () => {
  const original = contact("a", { personId: "existing" });
  const person = {
    pk: "PEOPLE",
    sk: "PERSON#existing",
    personId: "existing",
    revision: "r1",
    sources: [{ pk: original.pk, sk: original.sk }],
  };
  const f = fixture([copy("b", "a"), original, person]);
  await migratePeople({ apply: true, client: f.client });
  const put = f.writes()[0][0].Put;
  expect(put.ExpressionAttributeValues).toEqual({ ":revision": "r1" });
  expect(put.Item.personId).toBe("existing");
  expect(put.Item.sources).toHaveLength(2);
  const rerun = fixture([
    original,
    contact("b", { ...copy("b", "a"), personId: "existing" }),
    put.Item,
  ]);
  expect(
    (await migratePeople({ apply: true, client: rerun.client })).people,
  ).toBe(0);
  expect(rerun.writes()).toHaveLength(0);
});
it("reports missing sources, cycles, and conflicting identities without writes", async () => {
  const f = fixture([
    copy("missing", "absent"),
    copy("a", "b"),
    copy("b", "a"),
    contact("c", { personId: "one" }),
    { ...copy("d", "c"), personId: "two" },
  ]);
  const report = await migratePeople({ apply: true, client: f.client });
  expect(report.conflicts.map((c) => c.reason).sort()).toEqual([
    "person_identity_conflict",
    "source_cycle",
    "source_not_found",
  ]);
  expect(f.writes()).toHaveLength(0);
});
it("dry-run does not write and oversized groups are reported without splitting identity", async () => {
  const f = fixture([
    contact("a"),
    ...Array.from({ length: 99 }, (_, i) => copy(`c${i}`, "a")),
  ]);
  expect((await migratePeople({ client: f.client })).conflicts[0].reason).toBe(
    "transaction_limit",
  );
  expect(f.writes()).toHaveLength(0);
  const small = fixture([contact("a")]);
  expect((await migratePeople({ client: small.client })).people).toBe(1);
  expect(small.writes()).toHaveLength(0);
});
it("records conditional conflicts, continues later groups, and counts only successes", async () => {
  const f = fixture([contact("a"), contact("b")], async (command) => {
    if (command.input.TransactItems[1].Update.Key.sk === "USER#a")
      throw Object.assign(new Error("conflict"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ],
      });
    return {};
  });
  const report = await migratePeople({ apply: true, client: f.client });
  expect(report.people).toBe(1);
  expect(report.conflicts[0].reason).toBe("conditional_conflict");
  expect(f.writes()).toHaveLength(2);
});
it.each([
  new Error("network"),
  Object.assign(new Error("unknown cancellation"), {
    name: "TransactionCanceledException",
  }),
  Object.assign(new Error("validation"), {
    name: "TransactionCanceledException",
    CancellationReasons: [
      { Code: "ConditionalCheckFailed" },
      { Code: "ValidationError" },
    ],
  }),
])("rethrows unexpected failures: %s", async (error) => {
  const f = fixture([contact("a")], async () => {
    throw error;
  });
  await expect(migratePeople({ apply: true, client: f.client })).rejects.toBe(
    error,
  );
});

it("follows provider-manager sources and rejects mismatched site projection identities", async () => {
  const source = {
    pk: "PROVIDER#v",
    sk: "PROVIDER_MANAGER#m",
    providerId: "v",
    membershipId: "m",
  };
  const user = contact("a", {
    staffSource: { providerId: "v", providerManagerId: "m" },
  });
  const f = fixture([user, source]);
  expect((await migratePeople({ apply: true, client: f.client })).people).toBe(
    1,
  );
  const writes = f.writes()[0];
  expect(writes[0].Put.Item.primaryProviderId).toBe("v");
  expect(writes[1].Update.ConditionExpression).toContain(
    "staffSource = :source",
  );
  const bad = fixture(
    [
      source,
      user,
      {
        pk: "SITE#s",
        sk: "ASSIGNED_USER#a",
        programId: "p",
        userId: "a",
        personId: "other",
      },
      {
        ...source,
        personId: "original",
        pk: "PROVIDER#v",
        sk: "PROVIDER_MANAGER#m",
      },
    ].slice(1),
  );
  expect(
    (await migratePeople({ apply: true, client: bad.client })).conflicts[0]
      .reason,
  ).toBe("person_identity_conflict");
  expect(bad.writes()).toHaveLength(0);
});
