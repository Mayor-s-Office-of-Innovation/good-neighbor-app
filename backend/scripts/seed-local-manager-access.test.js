import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/db.js", () => ({ ddb: { send } }));
const device = {
  pk: "SITE#city-hall",
  sk: "DEVICE#synthetic-device",
  deviceId: "synthetic-device",
  label: "Synthetic manager phone",
  accessLevel: "manager",
  status: "active",
  tokenGeneration: 7,
};
let canonical;
beforeEach(() => {
  vi.resetModules();
  canonical = undefined;
  vi.stubEnv("DYNAMO_TABLE", "gnp-local-seed-test");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "synthetic-seed-verifier");
  for (const service of ["DYNAMODB", "SQS", "S3"])
    vi.stubEnv(`AWS_ENDPOINT_URL_${service}`, "http://localhost:8000");
  vi.spyOn(console, "log").mockImplementation(() => {});
  send.mockReset().mockImplementation(async (command) => {
    const input = command.input;
    if (input.Key?.pk === "SITE#city-hall" && input.Key.sk === "#META")
      return { Item: { status: "active", name: "City Hall" } };
    if (input.Key?.sk === "DEVICE_BINDING#synthetic-device")
      return { Item: canonical };
    if (input.KeyConditionExpression) return { Items: [device] };
    return {};
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("preserves the device label and session generation in canonical local fixtures", async () => {
  await import("./seed-local-manager-access.mjs");
  const writes = send.mock.calls.find(
    ([command]) => command.input.TransactItems,
  )[0].input.TransactItems;
  const binding = writes.find(
    (write) => write.Put?.Item.type === "deviceBinding",
  ).Put.Item;
  expect(binding).toMatchObject({
    label: device.label,
    tokenGeneration: 7,
    status: "active",
  });
  expect(
    writes.find((write) => write.Put?.Item.sk === `BINDING#${device.deviceId}`)
      .Put.Item.type,
  ).toBe("physicalDeviceBindingPointer");
  const update = writes.find((write) => write.Update).Update;
  expect(update.UpdateExpression).not.toContain("tokenGeneration =");
  expect(update.ConditionExpression).toContain(
    "tokenGeneration = :tokenGeneration",
  );
});

it("never restores an existing revoked canonical binding", async () => {
  canonical = { status: "revoked" };
  await import("./seed-local-manager-access.mjs");
  expect(send.mock.calls.some(([command]) => command.input.TransactItems)).toBe(
    false,
  );
});

it("refuses a production-shaped table before making any DynamoDB calls", async () => {
  vi.stubEnv("DYNAMO_TABLE", "good-neighbor-app-prod-app");
  await expect(import("./seed-local-manager-access.mjs")).rejects.toThrow(
    "gnp-local",
  );
  expect(send).not.toHaveBeenCalled();
});

it("backfills email pointers for an already-repaired fixture and is idempotent", async () => {
  const { emailHash } = await import("../src/handlers/setup-codes.js");
  const hash = await emailHash("cityhall@example.org");
  canonical = { status: "active", membershipId: "local-city-hall-manager" };
  const member = {
    pk: "SITE#city-hall",
    sk: "MANAGER_MEMBERSHIP#local-city-hall-manager",
    membershipId: "local-city-hall-manager",
    siteId: "city-hall",
    status: "active",
    generation: 1,
    email: "cityhall@example.org",
    emailHash: hash,
  };
  const pointers = new Map();
  const previous = send.getMockImplementation();
  send.mockImplementation(async (command) => {
    const input = command.input;
    if (input.Key?.sk === member.sk) return { Item: member };
    if (
      input.Key &&
      (input.Key.pk.startsWith("MANAGER_EMAIL#") ||
        input.Key.sk.startsWith("MANAGER_EMAIL#"))
    )
      return { Item: pointers.get(JSON.stringify(input.Key)) };
    if (input.TransactItems) {
      for (const write of input.TransactItems)
        if (write.Put) {
          const item = write.Put.Item;
          pointers.set(JSON.stringify({ pk: item.pk, sk: item.sk }), item);
        }
      return {};
    }
    return previous(command);
  });
  await import("./seed-local-manager-access.mjs");
  expect(pointers.size).toBe(2);
  expect([...pointers.values()].map((item) => item.type).sort()).toEqual([
    "managerMembershipDirectory",
    "managerMembershipEmail",
  ]);
  const transactions = () =>
    send.mock.calls.filter(([command]) => command.input.TransactItems);
  expect(transactions()).toHaveLength(1);
  expect(
    transactions()[0][0].input.TransactItems.some((write) => write.Update),
  ).toBe(false);
  vi.resetModules();
  await import("./seed-local-manager-access.mjs");
  expect(transactions()).toHaveLength(1);
});

it("rejects a conflicting site email assignment without writing", async () => {
  const previous = send.getMockImplementation();
  send.mockImplementation(async (command) =>
    command.input.Key?.sk.startsWith("MANAGER_EMAIL#")
      ? { Item: { membershipId: "someone-else", siteId: "city-hall" } }
      : previous(command),
  );
  await expect(import("./seed-local-manager-access.mjs")).rejects.toThrow(
    "conflicts",
  );
  expect(send.mock.calls.some(([command]) => command.input.TransactItems)).toBe(
    false,
  );
});

it("repairs an active membership's recovery directory even when all devices are revoked", async () => {
  const { emailHash } = await import("../src/handlers/setup-codes.js");
  const hash = await emailHash("cityhall@example.org");
  const previous = send.getMockImplementation();
  send.mockImplementation(async (command) => {
    const input = command.input;
    if (input.Key?.sk === "MANAGER_MEMBERSHIP#local-city-hall-manager")
      return {
        Item: {
          membershipId: "local-city-hall-manager",
          siteId: "city-hall",
          email: "cityhall@example.org",
          emailHash: hash,
          generation: 1,
          status: "active",
        },
      };
    if (input.KeyConditionExpression)
      return { Items: [{ ...device, status: "revoked" }] };
    return previous(command);
  });
  await import("./seed-local-manager-access.mjs");
  const transactions = send.mock.calls.filter(
    ([command]) => command.input.TransactItems,
  );
  expect(transactions).toHaveLength(1);
  const writes = transactions[0][0].input.TransactItems;
  expect(
    writes
      .filter((write) => write.Put)
      .map((write) => write.Put.Item.type)
      .sort(),
  ).toEqual(["managerMembershipDirectory", "managerMembershipEmail"]);
  expect(writes.some((write) => write.Update)).toBe(false);
});
