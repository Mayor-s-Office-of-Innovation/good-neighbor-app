import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { reserveUpload, uploadUrlLifetime } = await import(
  "./upload-reservations.js"
);
const parentGuard = {
  ConditionCheck: {
    TableName: "table",
    Key: { pk: "SITE#test", sk: "CHECK#test" },
    ConditionExpression: "attribute_exists(pk)",
  },
};
const reservation = {
  pk: "SITE#test",
  kind: "check",
  parentId: "test",
  createdBy: "actor",
  artifactId: "server-id",
  s3Key: "checks/test/server-id",
  contentType: "image/jpeg",
  contentLength: 100,
  createdAt: "2026-10-28T12:00:00.000Z",
};
const writes = [
  parentGuard,
  {
    Update: {
      TableName: "table",
      Key: { pk: "SITE#test", sk: "QUOTA" },
      UpdateExpression: "ADD reservedCount :one",
      ExpressionAttributeValues: { ":one": 1 },
    },
  },
];
const input = () => ({
  requestId: "request-1",
  tableName: "table",
  reservation: { ...reservation },
  writes,
  parentGuard,
});
const existing = () => ({
  ...reservation,
  renewUntil: Date.parse("2026-10-29T12:00:00Z") / 1000,
});
beforeEach(() => {
  send.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("creates the mapping atomically with quota and parent checks", async () => {
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
  const result = await reserveUpload(input());
  expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
  const transaction = send.mock.calls[1][0].input.TransactItems;
  expect(transaction.slice(0, 2)).toEqual(writes);
  expect(transaction[2].Put).toMatchObject({
    ConditionExpression: "attribute_not_exists(pk)",
    Item: {
      createdBy: "actor",
      artifactId: "server-id",
      contentLength: 100,
      renewUntil: existing().renewUntil,
    },
  });
  expect(result.expiresAt).toBe(existing().renewUntil + 86400);
});

it("replays the original artifact without a quota write or TTL extension", async () => {
  send.mockResolvedValueOnce({ Item: existing() }).mockResolvedValueOnce({});
  const result = await reserveUpload({
    ...input(),
    reservation: { ...reservation, artifactId: "discarded-new-id" },
  });
  expect(result.artifactId).toBe("server-id");
  expect(send.mock.calls[1][0].input.TransactItems).toEqual([parentGuard]);
});

it.each([
  { createdBy: "other-actor" },
  { contentType: "image/png" },
  { contentLength: 101 },
])("rejects mismatched reuse: %j", async (change) => {
  send.mockResolvedValueOnce({ Item: existing() });
  await expect(
    reserveUpload({ ...input(), reservation: { ...reservation, ...change } }),
  ).rejects.toMatchObject({ statusCode: 409, code: "upload_request_conflict" });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([null, "", "bad#key", "a".repeat(129)])(
  "rejects invalid request ID %s before writing",
  async (requestId) => {
    await expect(
      reserveUpload({ ...input(), requestId }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
  },
);

it("does not renew an expired mapping even when TTL has not deleted it", async () => {
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  send.mockResolvedValueOnce({ Item: existing() });
  await expect(reserveUpload(input())).rejects.toMatchObject({
    statusCode: 410,
    code: "upload_expired",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("re-reads a racing mapping winner rather than charging the retry", async () => {
  const race = Object.assign(new Error("race"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{}, {}, { Code: "ConditionalCheckFailed" }],
  });
  send
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(race)
    .mockResolvedValueOnce({ Item: existing() })
    .mockResolvedValueOnce({});
  expect((await reserveUpload(input())).artifactId).toBe("server-id");
  expect(send.mock.calls[3][0].input.TransactItems).toEqual([parentGuard]);
});

it("enforces parent status again before renewing", async () => {
  const error = Object.assign(new Error("parent unavailable"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
  send.mockResolvedValueOnce({ Item: existing() }).mockRejectedValueOnce(error);
  await expect(reserveUpload(input())).rejects.toBe(error);
});

it("keeps legacy callers compatible without extra reads", async () => {
  send.mockResolvedValue({});
  await reserveUpload({ ...input(), requestId: undefined });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBeInstanceOf(TransactWriteCommand);
  expect(send.mock.calls[0][0].input.TransactItems).toEqual(writes);
});

it("fails closed on storage errors", async () => {
  const error = new Error("unavailable");
  send.mockRejectedValueOnce(error);
  await expect(reserveUpload(input())).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
});

it("charges a racing pair only once and returns the winner to both", async () => {
  /** @type {Record<string, unknown> | undefined} */
  let committed;
  let charges = 0;
  send.mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: committed };
    const items = command.input.TransactItems;
    if (items.length === 1) return {};
    if (committed)
      throw Object.assign(new Error("race"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{}, {}, { Code: "ConditionalCheckFailed" }],
      });
    committed = items[2].Put.Item;
    charges++;
    return {};
  });
  const results = await Promise.all([
    reserveUpload(input()),
    reserveUpload({
      ...input(),
      reservation: { ...reservation, artifactId: "losing-id" },
    }),
  ]);
  expect(charges).toBe(1);
  expect(results.map((result) => result.artifactId)).toEqual([
    "server-id",
    "server-id",
  ]);
});

it("caps a renewed URL at its original deadline and rejects renewal after 24 hours", () => {
  vi.setSystemTime(new Date("2026-10-29T11:59:30Z"));
  expect(uploadUrlLifetime(existing())).toBe(30);
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  expect(() => uploadUrlLifetime(existing())).toThrow("upload_expired");
});

it("keeps a reservation created just before midnight renewable for 24 hours", async () => {
  const createdAt = "2026-10-28T23:59:59Z";
  vi.setSystemTime(new Date(createdAt));
  send.mockResolvedValue({});
  const result = await reserveUpload({
    ...input(),
    reservation: { ...reservation, createdAt },
  });
  expect(result.renewUntil).toBe(Date.parse("2026-10-29T23:59:59Z") / 1000);
  vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
  expect(uploadUrlLifetime(result)).toBe(300);
});
