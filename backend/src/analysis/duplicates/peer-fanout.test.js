import { afterEach, expect, it, vi } from "vitest";
import { peerFanout } from "./peer-fanout.js";

/** Atomic in-memory store implementing the claim's DynamoDB conditions. */
function store() {
  /** @type {Record<string, any>} */
  const row = {};
  const send = vi.fn(async (command) => {
    const i = command.input;
    if (!i.Item) return { Item: { ...row } };
    const v = i.ExpressionAttributeValues;
    const acquire = !!i.Item.owner;
    const complete = !!i.Item.completedAt;
    if (
      acquire
        ? row.completedAt || (row.leaseUntil ?? 0) > v[":now"]
        : row.owner !== v[":owner"] || (complete && row.leaseUntil <= v[":now"])
    )
      throw Object.assign(new Error("Condition failed"), {
        name: "ConditionalCheckFailedException",
      });
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, i.Item);
    return {};
  });
  const run = (/** @type {(assertLease:()=>void)=>Promise<void>} */ work) =>
    peerFanout({
      ddb: /** @type {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} */ (
        /** @type {unknown} */ ({ send })
      ),
      table: "test",
      key: { pk: "SITE#site", sk: "DUP_PEER_RECONCILIATION#source#revision" },
      work,
    });
  return { row, send, run };
}
afterEach(() => vi.useRealTimers());

it("reserves fanout atomically and retries contention rather than acknowledging it", async () => {
  const { run, row } = store();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const work = vi.fn(async () => {
    await gate;
  });
  const first = run(work);
  await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
  await expect(run(work)).rejects.toThrow("already claimed");
  expect(work).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(row.completedAt).toBeDefined();
  await run(work);
  expect(work).toHaveBeenCalledTimes(1);
});

it("releases failed work for retry, and completes only after all sends succeed", async () => {
  const { run, row } = store();
  const sends = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("send failed"))
    .mockResolvedValue(undefined);
  const work = async () => {
    await sends();
    await sends();
  };
  await expect(run(work)).rejects.toThrow("send failed");
  expect(row.completedAt).toBeUndefined();
  expect(row.owner).toBeUndefined();
  await run(work);
  await run(work);
  expect(sends).toHaveBeenCalledTimes(4);
});

it("reclaims an expired claim left by a crashed worker", async () => {
  vi.useFakeTimers();
  const { run, row } = store();
  Object.assign(row, { owner: "crashed", leaseUntil: Date.now() - 1 });
  const work = vi.fn(async () => {});
  await run(work);
  expect(work).toHaveBeenCalledTimes(1);
  expect(row.completedAt).toBeDefined();
  expect(row.owner).toBeUndefined();
});

it("an expired worker cannot complete or release a replacement owner's claim", async () => {
  vi.useFakeTimers();
  const { run, row } = store();
  let finishOld = () => {};
  const old = run(async () => {
    await new Promise((resolve) => {
      finishOld = () => resolve(undefined);
    });
  });
  await vi.advanceTimersByTimeAsync(0);
  const oldOwner = row.owner;
  await vi.advanceTimersByTimeAsync(60_001);
  let finishNew = () => {};
  const newer = run(async () => {
    await new Promise((resolve) => {
      finishNew = () => resolve(undefined);
    });
  });
  await vi.advanceTimersByTimeAsync(0);
  const newOwner = row.owner;
  expect(newOwner).not.toBe(oldOwner);
  const rejected = expect(old).rejects.toThrow("lease expired");
  finishOld();
  await rejected;
  expect(row.owner).toBe(newOwner);
  expect(row.completedAt).toBeUndefined();
  finishNew();
  await newer;
  expect(row.completedAt).toBeDefined();
});

it("does not send when the acquire acknowledgement arrives after expiry", async () => {
  vi.useFakeTimers();
  const { run, send, row } = store();
  const original = send.getMockImplementation();
  send.mockImplementationOnce(async (command) => {
    const result = await original?.(command);
    await vi.advanceTimersByTimeAsync(60_001);
    return result ?? {};
  });
  const work = vi.fn(async () => {});
  await expect(run(work)).rejects.toThrow("lease expired");
  expect(work).not.toHaveBeenCalled();
  expect(row.completedAt).toBeUndefined();
});

it("fences a completion write that arrives after a replacement worker acquires the lease", async () => {
  vi.useFakeTimers();
  const { run, send, row } = store();
  const original = send.getMockImplementation();
  let unblock = () => {};
  let completionWaiting = false;
  send.mockImplementation(async (command) => {
    if (command.input.Item?.completedAt && !completionWaiting) {
      completionWaiting = true;
      await new Promise((resolve) => {
        unblock = () => resolve(undefined);
      });
    }
    return (await original?.(command)) ?? {};
  });
  const first = run(async () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(completionWaiting).toBe(true);
  await vi.advanceTimersByTimeAsync(60_001);
  let finishNew = () => {};
  const replacement = run(async () => {
    await new Promise((resolve) => {
      finishNew = () => resolve(undefined);
    });
  });
  await vi.advanceTimersByTimeAsync(0);
  const newOwner = row.owner;
  const rejected = expect(first).rejects.toMatchObject({
    name: "ConditionalCheckFailedException",
  });
  unblock();
  await rejected;
  expect(row.owner).toBe(newOwner);
  expect(row.completedAt).toBeUndefined();
  finishNew();
  await replacement;
  expect(row.completedAt).toBeDefined();
});
