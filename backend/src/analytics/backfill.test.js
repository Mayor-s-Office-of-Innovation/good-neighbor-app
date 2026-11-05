import { describe, expect, it } from "vitest";
import { STATE_KEY, backfillIfFormatChanged } from "./backfill.js";

const BUCKET = "lake";
const manifest = (/** @type {string} */ id) =>
  `raw/AWSDynamoDB/${id}/manifest-summary.json`;

/**
 * An in-memory lake bucket that answers the three calls the backfill makes.
 * @param {Record<string, string>} objects key → LastModified
 * @param {{ state?: object, pageSize?: number }} [opts]
 */
function fakeS3(objects, opts = {}) {
  /** @type {string | null} */
  let state = opts.state ? JSON.stringify(opts.state) : null;
  const keys = Object.keys(objects).sort();
  const pageSize = opts.pageSize ?? 1000;
  /** @type {object[]} */
  const writes = [];
  /** @param {any} command */
  const send = async (command) => {
    const input = command.input;
    const name = command.constructor.name;
    if (name === "GetObjectCommand") {
      if (input.Key !== STATE_KEY || state === null)
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      const body = state;
      return { Body: { transformToString: async () => body } };
    }
    if (name === "PutObjectCommand") {
      state = input.Body;
      writes.push(JSON.parse(input.Body));
      return {};
    }
    const start = Number(input.ContinuationToken ?? 0);
    const page = keys.slice(start, start + pageSize);
    const next = start + pageSize;
    return {
      Contents: page.map((Key) => ({
        Key,
        LastModified: new Date(objects[Key]),
      })),
      IsTruncated: next < keys.length,
      NextContinuationToken: String(next),
    };
  };
  return { send, writes, state: () => (state ? JSON.parse(state) : null) };
}

/** @param {{ failOn?: string }} [opts] */
function recorder(opts = {}) {
  /** @type {[string, string][]} */
  const calls = [];
  /**
   * @param {string} _bucket
   * @param {string} key
   * @param {string} at
   */
  const convert = async (_bucket, key, at) => {
    if (key === opts.failOn) throw new Error("timed out");
    calls.push([key, at]);
  };
  return { calls, convert };
}

const LAKE = {
  [manifest("e2")]: "2026-10-02T06:00:00.000Z",
  [manifest("e1")]: "2026-10-01T06:00:00.000Z",
  "raw/AWSDynamoDB/e1/data/part-1.json.gz": "2026-10-01T05:59:00.000Z",
  [manifest("e3")]: "2026-10-03T06:00:00.000Z",
};

describe("backfillIfFormatChanged", () => {
  it("re-converts every earlier export once, oldest first, at its own time", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    const { calls, convert } = recorder();
    const result = await backfillIfFormatChanged({
      send: s3.send,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
      skip: new Set([manifest("e3")]),
    });
    expect(calls).toEqual([
      [manifest("e1"), "2026-10-01T06:00:00.000Z"],
      [manifest("e2"), "2026-10-02T06:00:00.000Z"],
    ]);
    expect(result).toEqual({ backfilled: 2, finished: true });
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
    expect(s3.state().backfill).toBeUndefined();
  });

  it("does nothing on a rerun once the version is recorded", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    const deps = { send: s3.send, bucket: BUCKET, formatVersion: 2 };
    await backfillIfFormatChanged({ ...deps, convert: recorder().convert });
    const again = recorder();
    expect(
      await backfillIfFormatChanged({ ...deps, convert: again.convert }),
    ).toEqual({ backfilled: 0, finished: true });
    expect(again.calls).toEqual([]);
  });

  it("backfills a lake that has never recorded a version", async () => {
    const s3 = fakeS3(LAKE);
    const { calls, convert } = recorder();
    await backfillIfFormatChanged({
      send: s3.send,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
    });
    expect(calls).toHaveLength(3);
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
  });

  it("keeps the old version after a failure, and the retry skips finished exports", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    const deps = { send: s3.send, bucket: BUCKET, formatVersion: 2 };
    const failing = recorder({ failOn: manifest("e2") });
    await expect(
      backfillIfFormatChanged({ ...deps, convert: failing.convert }),
    ).rejects.toThrow("timed out");
    expect(s3.state()).toMatchObject({
      formatVersion: 1,
      backfill: { formatVersion: 2, done: [manifest("e1")] },
    });
    const retry = recorder();
    await backfillIfFormatChanged({ ...deps, convert: retry.convert });
    expect(retry.calls.map(([key]) => key)).toEqual([
      manifest("e2"),
      manifest("e3"),
    ]);
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
  });

  it("starts over when a newer version replaces an unfinished backfill", async () => {
    const s3 = fakeS3(LAKE, {
      state: {
        formatVersion: 1,
        backfill: { formatVersion: 2, done: [manifest("e1")] },
      },
    });
    const { calls, convert } = recorder();
    await backfillIfFormatChanged({
      send: s3.send,
      convert,
      bucket: BUCKET,
      formatVersion: 3,
    });
    expect(calls).toHaveLength(3);
  });

  it("reads every page of a long raw/ listing", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 }, pageSize: 1 });
    const { calls, convert } = recorder();
    await backfillIfFormatChanged({
      send: s3.send,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
    });
    expect(calls).toHaveLength(3);
  });

  it("stops before the Lambda timeout and the next run finishes", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    const deps = { send: s3.send, bucket: BUCKET, formatVersion: 2 };
    let left = 200_000;
    const first = recorder();
    const result = await backfillIfFormatChanged({
      ...deps,
      convert: async (bucket, key, at) => {
        await first.convert(bucket, key, at);
        left -= 90_000;
      },
      timeLeftMs: () => left,
    });
    expect(result).toEqual({ backfilled: 1, finished: false });
    expect(s3.state()).toMatchObject({ formatVersion: 1 });
    const next = recorder();
    await backfillIfFormatChanged({ ...deps, convert: next.convert });
    expect(next.calls.map(([key]) => key)).toEqual([
      manifest("e2"),
      manifest("e3"),
    ]);
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
  });

  it("lists exports under the configured prefix", async () => {
    const s3 = fakeS3({
      "exports/AWSDynamoDB/e1/manifest-summary.json":
        "2026-10-01T06:00:00.000Z",
    });
    /** @type {string[]} */
    const prefixes = [];
    const { calls, convert } = recorder();
    await backfillIfFormatChanged({
      send: async (command) => {
        if (command.constructor.name === "ListObjectsV2Command")
          prefixes.push(command.input.Prefix);
        return s3.send(command);
      },
      convert,
      bucket: BUCKET,
      prefix: "exports",
      formatVersion: 2,
    });
    expect(prefixes).toEqual(["exports/"]);
    expect(calls).toHaveLength(1);
  });

  it("fails rather than backfill when the state can't be read", async () => {
    const send = async () => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    };
    const { calls, convert } = recorder();
    await expect(
      backfillIfFormatChanged({
        send,
        convert,
        bucket: BUCKET,
        formatVersion: 2,
      }),
    ).rejects.toThrow("denied");
    expect(calls).toEqual([]);
  });
});
