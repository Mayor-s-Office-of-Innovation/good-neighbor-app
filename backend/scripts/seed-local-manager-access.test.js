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
