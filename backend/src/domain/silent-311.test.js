import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({
  getConfig: () => ({ dynamoTable: "table" }),
}));
import {
  assertSilent311Allowed,
  readSilent311Control,
  withSilent311Guard,
  Silent311Suppressed,
} from "./silent-311.js";
beforeEach(() => {
  send.mockReset().mockResolvedValue({});
});
it("defaults to enabled with a strongly consistent global read", async () => {
  expect(await readSilent311Control()).toMatchObject({
    enabled: true,
    revision: 0,
  });
  expect(send.mock.calls[0][0].input).toMatchObject({
    ConsistentRead: true,
    Key: { pk: "SYSTEM#CONTROLS", sk: "SILENT_311" },
  });
});
it("does not gate manual operations or read the control outside a silent context", async () => {
  await assertSilent311Allowed();
  expect(send).not.toHaveBeenCalled();
});
it("drops disabled work and permits no remote calls", async () => {
  send.mockResolvedValue({ Item: { enabled: false } });
  const remote = vi.fn();
  await expect(
    withSilent311Guard("2026-10-30T10:00:00Z", remote),
  ).rejects.toBeInstanceOf(Silent311Suppressed);
  expect(remote).not.toHaveBeenCalled();
});
it("never replays old workflows or unknown legacy timestamps after enabling", async () => {
  send.mockResolvedValue({
    Item: { enabled: true, epochStartedAt: "2026-10-30T12:00:00Z" },
  });
  for (const created of [
    "",
    "invalid",
    "2026-10-30T10:00:00Z",
    "2026-10-30T12:00:00.000Z",
    "2026-10-30T05:00:00-07:00",
  ])
    await expect(
      withSilent311Guard(created, async () => {}),
    ).rejects.toBeInstanceOf(Silent311Suppressed);
  await expect(
    withSilent311Guard("2026-10-30T13:00:00Z", async () => "new"),
  ).resolves.toBe("new");
});
it("rechecks before subsequent requests when disabled during a workflow", async () => {
  await expect(
    withSilent311Guard("2026-10-30T10:00:00Z", async () => {
      send.mockResolvedValue({ Item: { enabled: false } });
      await assertSilent311Allowed();
    }),
  ).rejects.toBeInstanceOf(Silent311Suppressed);
});
it("fails closed on unavailable control storage", async () => {
  send.mockRejectedValue(new Error("unavailable"));
  const remote = vi.fn();
  await expect(withSilent311Guard("today", remote)).rejects.toThrow(
    "unavailable",
  );
  expect(remote).not.toHaveBeenCalled();
});

it("blocks the actual City transport if disabled between operations", async () => {
  const { createSf311Client } = await import("../integrations/sf311-client.js");
  const fetchImpl = vi.fn();
  const client = createSf311Client({
    config: {
      dynamoTable: "table",
      uploadBucket: "bucket",
      queueUrl: "queue",
      sf311UpdateSrUrl: "https://hub.test/update",
      sf311BasicAuthUser: "synthetic-user",
      sf311BasicAuthPass: "synthetic-password",
    },
    fetchImpl,
  });
  await expect(
    withSilent311Guard("2026-10-30T12:00:00Z", async () => {
      send.mockResolvedValue({ Item: { enabled: false } });
      await client.updateServiceRequest({ SRnum: "123" });
    }),
  ).rejects.toBeInstanceOf(Silent311Suppressed);
  expect(fetchImpl).not.toHaveBeenCalled();
});
