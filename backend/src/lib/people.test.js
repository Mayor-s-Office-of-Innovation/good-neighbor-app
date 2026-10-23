import { beforeEach, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { personRecord, updatePersonRecord } = await import("./people.js");
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-secret");
});
it("keeps same-email people separate and gives affiliations no authority", () => {
  const a = personRecord({
    firstName: "A",
    lastName: "B",
    email: "shared@example.org",
    primaryProviderId: "p",
  });
  const b = personRecord({
    firstName: "A",
    lastName: "B",
    email: "shared@example.org",
  });
  expect(a.personId).not.toBe(b.personId);
  expect(a.sources).toEqual([]);
  expect(a).not.toHaveProperty("generation");
});
it("updates the person and linked contacts atomically without changing membership authority", async () => {
  const source = {
    pk: "PROVIDER#p",
    sk: "PROVIDER_MANAGER#m",
    personId: "person",
    providerId: "p",
    membershipId: "m",
    email: "old@example.org",
    status: "active",
    generation: 7,
    updatedAt: "before",
  };
  const person = personRecord(
    { firstName: "A", lastName: "B", email: source.email },
    "person",
    [{ pk: source.pk, sk: source.sk }],
  );
  send.mockImplementation(async (command) =>
    command instanceof GetCommand ? { Item: source } : {},
  );
  const next = await updatePersonRecord(
    person,
    { firstName: "New", lastName: "Name", email: "new@example.org" },
    "actor",
  );
  const writes = /** @type {any[]} */ (
    send.mock.calls.find(([c]) => c instanceof TransactWriteCommand)?.[0].input
      .TransactItems
  );
  const member = writes.find((w) => w.Put?.Item?.sk === source.sk).Put.Item;
  expect(member.generation).toBe(7);
  expect(member.status).toBe("active");
  expect(member.email).toBe(next.email);
  expect(writes[0].Put.ConditionExpression).toBe("revision = :revision");
  expect(
    writes.some((w) => w.Delete?.Key.pk.startsWith("PROVIDER_MANAGER_EMAIL#")),
  ).toBe(true);
});
it("rejects an inactive affiliation before writing any contact changes", async () => {
  send.mockResolvedValue({ Item: { status: "inactive" } });
  const person = personRecord({
    firstName: "A",
    lastName: "B",
    email: "a@example.org",
  });
  await expect(
    updatePersonRecord(
      person,
      { ...person, primaryProgramId: "inactive" },
      "actor",
    ),
  ).rejects.toThrow("affiliation_not_found");
  expect(send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(
    false,
  );
});
