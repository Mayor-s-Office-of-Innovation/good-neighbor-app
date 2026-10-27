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
    const acquire = i.ConditionExpression.includes(
      "attribute_not_exists(completedAt)",
    );
    const cursorMatches = i.ConditionExpression.includes(
      "lastPeerKey = :cursor",
    )
      ? row.lastPeerKey === v[":cursor"]
      : !i.ConditionExpression.includes("attribute_not_exists(lastPeerKey)") ||
        row.lastPeerKey === undefined;
    if (
      !cursorMatches ||
      (acquire
        ? row.completedAt || (row.leaseUntil ?? 0) > v[":now"]
        : row.owner !== v[":owner"] ||
          (i.ConditionExpression.includes("leaseUntil > :now") &&
            row.leaseUntil <= v[":now"]))
    )
      throw Object.assign(new Error("Condition failed"), {
        name: "ConditionalCheckFailedException",
      });
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, i.Item);
    return {};
  });
  const run = (/** @type {Parameters<typeof peerFanout>[0]["work"]} */ work) =>
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
  let delayed = false;
  send.mockImplementation(async (command) => {
    const result = await original?.(command);
    if (command.input.Item?.owner && !delayed) {
      delayed = true;
      await vi.advanceTimersByTimeAsync(60_001);
    }
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

it("renews the lease and reaches every peer when total send time exceeds one lease", async () => {
  vi.useFakeTimers();
  const { run, row } = store();
  const started = Date.now();
  /** @type {string[]} */
  const delivered = [];
  await run(async (_assertLease, sendPeer) => {
    for (const key of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      await sendPeer(key, async () => {
        await vi.advanceTimersByTimeAsync(12_000);
        delivered.push(key);
      });
    }
  });
  expect(Date.now() - started).toBe(96_000);
  expect(delivered).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  expect(row.lastPeerKey).toBe("h");
  expect(row.completedAt).toBeDefined();
});

it("resumes a stable peer-key cursor after interruption even when the pending list changes", async () => {
  const { run, row } = store();
  /** @type {string[]} */
  const delivered = [];
  await expect(
    run(async (_assertLease, sendPeer) => {
      for (const key of ["a", "b", "c", "d"]) {
        await sendPeer(key, async () => {
          if (key === "c") throw new Error("interrupted");
          delivered.push(key);
        });
      }
    }),
  ).rejects.toThrow("interrupted");
  expect(row.lastPeerKey).toBe("b");
  expect(row.completedAt).toBeUndefined();
  await run(async (_assertLease, sendPeer) => {
    // "a" disappeared because its own worker completed meanwhile. Array-index
    // progress would skip "c"; a stable key still resumes correctly.
    for (const key of ["b", "c", "d"])
      await sendPeer(key, async () => {
        delivered.push(key);
      });
  });
  expect(delivered).toEqual(["a", "b", "c", "d"]);
  expect(row.completedAt).toBeDefined();
});

it("preserves progress when a successful checkpoint write loses its acknowledgement", async () => {
  const { run, send, row } = store();
  const original = send.getMockImplementation();
  let failed = false;
  send.mockImplementation(async (command) => {
    const result = await original?.(command);
    if (
      command.input.Item?.lastPeerKey === "a" &&
      command.input.Item.owner &&
      !failed
    ) {
      failed = true;
      throw new Error("checkpoint acknowledgement lost");
    }
    return result ?? {};
  });
  /** @type {string[]} */
  const delivered = [];
  const work = async (
    /** @type {()=>void} */ _assertLease,
    /** @type {(key:string,send:()=>Promise<unknown>)=>Promise<void>} */ sendPeer,
  ) => {
    for (const key of ["a", "b"])
      await sendPeer(key, async () => {
        delivered.push(key);
      });
  };
  await expect(run(work)).rejects.toThrow("acknowledgement lost");
  expect(row.lastPeerKey).toBe("a");
  await run(work);
  expect(delivered).toEqual(["a", "b"]);
});

it("fences a delayed renewal from a stale owner without losing replacement progress", async () => {
  vi.useFakeTimers();
  const { run, send, row } = store();
  const original = send.getMockImplementation();
  let unblock = () => {};
  let waiting = false;
  send.mockImplementation(async (command) => {
    if (
      command.input.Item?.lastPeerKey === "a" &&
      command.input.Item.owner &&
      !waiting
    ) {
      waiting = true;
      await new Promise((resolve) => {
        unblock = () => resolve(undefined);
      });
    }
    return (await original?.(command)) ?? {};
  });
  const old = run(async (_assertLease, sendPeer) => {
    await sendPeer("a", async () => {});
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(waiting).toBe(true);
  await vi.advanceTimersByTimeAsync(60_001);
  let finishNew = () => {};
  const replacement = run(async (_assertLease, sendPeer) => {
    await sendPeer("b", async () => {});
    await new Promise((resolve) => {
      finishNew = () => resolve(undefined);
    });
  });
  await vi.advanceTimersByTimeAsync(0);
  const newOwner = row.owner;
  expect(row.lastPeerKey).toBe("b");
  const rejected = expect(old).rejects.toMatchObject({
    name: "ConditionalCheckFailedException",
  });
  unblock();
  await rejected;
  expect(row.owner).toBe(newOwner);
  expect(row.lastPeerKey).toBe("b");
  finishNew();
  await replacement;
  expect(row.completedAt).toBeDefined();
});

it("a delayed claimant cannot erase progress made and released by another owner", async () => {
  const { run, send, row } = store();
  row.lastPeerKey = "a";
  const original = send.getMockImplementation();
  let unblock = () => {};
  let waiting = false;
  send.mockImplementation(async (command) => {
    if (
      command.input.ConditionExpression?.includes(
        "attribute_not_exists(completedAt)",
      ) &&
      !waiting
    ) {
      waiting = true;
      await new Promise((resolve) => {
        unblock = () => resolve(undefined);
      });
    }
    return (await original?.(command)) ?? {};
  });
  const work = vi.fn(async () => {});
  const delayed = run(work);
  await vi.waitFor(() => expect(waiting).toBe(true));
  await expect(
    run(async (_assertLease, sendPeer) => {
      await sendPeer("b", async () => {});
      throw new Error("interrupted after b");
    }),
  ).rejects.toThrow("interrupted after b");
  expect(row.lastPeerKey).toBe("b");
  expect(row.owner).toBeUndefined();
  const rejected = expect(delayed).rejects.toThrow("advanced");
  unblock();
  await rejected;
  expect(work).not.toHaveBeenCalled();
  expect(row.lastPeerKey).toBe("b");
});

it("renews a nearly expired claim before starting the next send", async () => {
  vi.useFakeTimers();
  const { run, row } = store();
  let sent = false;
  await run(async (_assertLease, sendPeer) => {
    await vi.advanceTimersByTimeAsync(50_000);
    await sendPeer("a", async () => {
      expect(row.leaseUntil - Date.now()).toBe(60_000);
      await vi.advanceTimersByTimeAsync(12_000);
      sent = true;
    });
  });
  expect(sent).toBe(true);
  expect(row.lastPeerKey).toBe("a");
  expect(row.completedAt).toBeDefined();
});
