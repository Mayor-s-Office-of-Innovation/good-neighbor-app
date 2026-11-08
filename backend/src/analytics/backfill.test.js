import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_KEY, backfillIfFormatChanged } from "./backfill.js";

const BUCKET = "lake";
const manifest = (/** @type {string} */ id) =>
  `raw/AWSDynamoDB/${id}/manifest-summary.json`;

/**
 * An in-memory lake bucket that answers the three calls the backfill makes.
 * @param {Record<string, string>} objects key → LastModified
 * @param {{ state?: object, pageSize?: number, sizes?: Record<string, number> }} [opts]
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
        Size: opts.sizes?.[Key] ?? 100,
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

const TABLE_ARN = "arn:aws:dynamodb:us-west-2:111111111111:table/app";
const exportArn = (/** @type {string} */ id) => `${TABLE_ARN}/export/${id}`;
// DynamoDB writes a full export under <prefix>/AWSDynamoDB/<export ID>/.
const FULL = manifest("full1");

/**
 * A fake DynamoDB that starts full exports and answers DescribeExport.
 * @param {{ statuses?: string[], startFails?: boolean }} [opts] statuses in the order DescribeExport returns them
 */
function fakeDynamo(opts = {}) {
  /** @type {any[]} */
  const starts = [];
  /** @type {string[]} */
  const described = [];
  const statuses = [...(opts.statuses ?? [])];
  /** @param {any} command */
  const send = async (command) => {
    const name = command.constructor.name;
    if (name === "ExportTableToPointInTimeCommand") {
      if (opts.startFails)
        throw Object.assign(new Error("PITR is off"), {
          name: "PointInTimeRecoveryUnavailableException",
        });
      starts.push(command.input);
      return {
        ExportDescription: { ExportArn: exportArn(`full${starts.length}`) },
      };
    }
    if (name === "DescribeExportCommand") {
      described.push(command.input.ExportArn);
      return {
        ExportDescription: { ExportStatus: statuses.shift() ?? "IN_PROGRESS" },
      };
    }
    throw new Error(`unexpected ${name}`);
  };
  return {
    send,
    starts,
    described,
    deps: { ddbSend: send, tableArn: TABLE_ARN },
  };
}

/**
 * State once version 2's full export has started.
 * @param {string[]} [done]
 */
const startedFull = (done = []) => ({
  formatVersion: 1,
  backfill: {
    formatVersion: 2,
    done,
    fullExport: { exportArn: exportArn("full1"), attempt: 1 },
  },
});

const LAKE = {
  [manifest("e2")]: "2026-10-02T06:00:00.000Z",
  [manifest("e1")]: "2026-10-01T06:00:00.000Z",
  "raw/AWSDynamoDB/e1/data/part-1.json.gz": "2026-10-01T05:59:00.000Z",
  [manifest("e3")]: "2026-10-03T06:00:00.000Z",
};

describe("backfillIfFormatChanged", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("re-converts every earlier export once, oldest first, at its own time", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const { calls, convert } = recorder();
    const result = await backfillIfFormatChanged({
      send: s3.send,
      ...fakeDynamo().deps,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
      skip: new Set([manifest("e3"), FULL]),
    });
    expect(calls).toEqual([
      [manifest("e1"), "2026-10-01T06:00:00.000Z"],
      [manifest("e2"), "2026-10-02T06:00:00.000Z"],
    ]);
    expect(result).toEqual({ backfilled: 2, failed: 0, finished: true });
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
    expect(s3.state().backfill).toBeUndefined();
  });

  it("does nothing on a rerun once the version is recorded", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const dynamo = fakeDynamo();
    const deps = {
      send: s3.send,
      ...dynamo.deps,
      bucket: BUCKET,
      formatVersion: 2,
    };
    await backfillIfFormatChanged({
      ...deps,
      convert: recorder().convert,
      skip: new Set([FULL]),
    });
    const again = recorder();
    expect(
      await backfillIfFormatChanged({ ...deps, convert: again.convert }),
    ).toEqual({ backfilled: 0, failed: 0, finished: true });
    expect(again.calls).toEqual([]);
    expect(dynamo.starts).toEqual([]);
  });

  it("backfills a lake that has never recorded a version", async () => {
    const s3 = fakeS3(LAKE);
    const dynamo = fakeDynamo();
    const { calls, convert } = recorder();
    await backfillIfFormatChanged({
      send: s3.send,
      ...dynamo.deps,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
    });
    expect(calls).toHaveLength(3);
    expect(dynamo.starts).toHaveLength(1);
    expect(s3.state()).toMatchObject({
      formatVersion: null,
      backfill: { formatVersion: 2 },
    });
  });

  it("converts past a failing export, keeps the old version, and retries only that one", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const deps = {
      send: s3.send,
      ...fakeDynamo().deps,
      bucket: BUCKET,
      formatVersion: 2,
    };
    const failing = recorder({ failOn: manifest("e2") });
    expect(
      await backfillIfFormatChanged({
        ...deps,
        convert: failing.convert,
        skip: new Set([FULL]),
      }),
    ).toEqual({ backfilled: 2, failed: 1, finished: false });
    expect(failing.calls.map(([key]) => key)).toEqual([
      manifest("e1"),
      manifest("e3"),
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(manifest("e2")),
    );
    expect(s3.state()).toMatchObject({
      formatVersion: 1,
      backfill: {
        formatVersion: 2,
        done: [FULL, manifest("e1"), manifest("e3")],
      },
    });
    const retry = recorder();
    await backfillIfFormatChanged({ ...deps, convert: retry.convert });
    expect(retry.calls.map(([key]) => key)).toEqual([manifest("e2")]);
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
  });

  it("leaves a large export for a fresh run when it won't fit the time left", async () => {
    const s3 = fakeS3(LAKE, {
      state: { formatVersion: 1 },
      sizes: { "raw/AWSDynamoDB/e1/data/part-1.json.gz": 200_000_000 },
    });
    const { calls, convert } = recorder();
    const result = await backfillIfFormatChanged({
      send: s3.send,
      ...fakeDynamo().deps,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
      timeLeftMs: () => 300_000,
    });
    expect(result).toEqual({ backfilled: 0, failed: 0, finished: false });
    expect(calls).toEqual([]);
  });

  it("logs and passes an export too large for any one run", async () => {
    const s3 = fakeS3(LAKE, {
      state: { formatVersion: 1 },
      sizes: { "raw/AWSDynamoDB/e1/data/part-1.json.gz": 900_000_000 },
    });
    const { calls, convert } = recorder();
    const result = await backfillIfFormatChanged({
      send: s3.send,
      ...fakeDynamo().deps,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
      timeLeftMs: () => 590_000,
    });
    expect(result).toEqual({ backfilled: 2, failed: 1, finished: false });
    expect(calls.map(([key]) => key)).toEqual([manifest("e2"), manifest("e3")]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("too large"),
    );
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
      ...fakeDynamo().deps,
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
      ...fakeDynamo().deps,
      convert,
      bucket: BUCKET,
      formatVersion: 2,
    });
    expect(calls).toHaveLength(3);
  });

  it("stops before the Lambda timeout and the next run finishes", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const deps = {
      send: s3.send,
      ...fakeDynamo().deps,
      bucket: BUCKET,
      formatVersion: 2,
    };
    let left = 200_000;
    const first = recorder();
    const result = await backfillIfFormatChanged({
      ...deps,
      skip: new Set([FULL]),
      convert: async (bucket, key, at) => {
        await first.convert(bucket, key, at);
        left -= 90_000;
      },
      timeLeftMs: () => left,
    });
    expect(result).toEqual({ backfilled: 1, failed: 0, finished: false });
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
    const dynamo = fakeDynamo();
    const { calls, convert } = recorder();
    await backfillIfFormatChanged({
      send: async (command) => {
        if (command.constructor.name === "ListObjectsV2Command")
          prefixes.push(command.input.Prefix);
        return s3.send(command);
      },
      ...dynamo.deps,
      convert,
      bucket: BUCKET,
      prefix: "exports",
      formatVersion: 2,
    });
    expect(prefixes).toEqual(["exports/"]);
    expect(dynamo.starts[0]).toMatchObject({ S3Prefix: "exports" });
    expect(calls).toHaveLength(1);
  });

  it("fails rather than backfill when the state can't be read", async () => {
    const send = async () => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    };
    const { calls, convert } = recorder();
    const dynamo = fakeDynamo();
    await expect(
      backfillIfFormatChanged({
        send,
        ...dynamo.deps,
        convert,
        bucket: BUCKET,
        formatVersion: 2,
      }),
    ).rejects.toThrow("denied");
    expect(calls).toEqual([]);
    expect(dynamo.starts).toEqual([]);
  });
});

describe("backfillIfFormatChanged full export", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /**
   * @param {ReturnType<typeof fakeS3>} s3
   * @param {ReturnType<typeof fakeDynamo>} dynamo
   * @param {{ skip?: string[], formatVersion?: number }} [opts]
   */
  const run = (s3, dynamo, opts = {}) =>
    backfillIfFormatChanged({
      send: s3.send,
      ...dynamo.deps,
      convert: recorder().convert,
      bucket: BUCKET,
      formatVersion: opts.formatVersion ?? 2,
      skip: new Set(opts.skip ?? []),
    });

  it("starts one full export where the scheduled exports land, and records the version only after it converts", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    const dynamo = fakeDynamo({ statuses: ["IN_PROGRESS"] });

    expect(await run(s3, dynamo)).toMatchObject({ finished: false });
    expect(dynamo.starts).toEqual([
      {
        TableArn: TABLE_ARN,
        S3Bucket: BUCKET,
        S3Prefix: "raw",
        ExportFormat: "DYNAMODB_JSON",
        ExportType: "FULL_EXPORT",
        ClientToken: "format-2-1",
      },
    ]);
    expect(s3.state()).toMatchObject({
      formatVersion: 1,
      backfill: { fullExport: { exportArn: exportArn("full1"), attempt: 1 } },
    });

    expect(await run(s3, dynamo)).toMatchObject({ finished: false });
    expect(dynamo.starts).toHaveLength(1);
    expect(dynamo.described).toEqual([exportArn("full1")]);
    expect(s3.state()).toMatchObject({ formatVersion: 1 });

    expect(await run(s3, dynamo, { skip: [FULL] })).toMatchObject({
      finished: true,
    });
    expect(dynamo.starts).toHaveLength(1);
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
    expect(s3.state().backfill).toBeUndefined();
  });

  it("waits for a completed export's own conversion instead of starting another", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const dynamo = fakeDynamo({ statuses: ["COMPLETED"] });
    expect(await run(s3, dynamo)).toMatchObject({ finished: false });
    expect(dynamo.starts).toEqual([]);
    expect(s3.state()).toMatchObject({ formatVersion: 1 });
  });

  it("starts a new export with a new token when the first one fails", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const dynamo = fakeDynamo({ statuses: ["FAILED"] });
    expect(await run(s3, dynamo)).toMatchObject({ finished: false });
    expect(dynamo.starts).toEqual([
      expect.objectContaining({ ClientToken: "format-2-2" }),
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(exportArn("full1")),
    );
    expect(s3.state()).toMatchObject({
      formatVersion: 1,
      backfill: { fullExport: { exportArn: exportArn("full1"), attempt: 2 } },
    });
  });

  it("counts the full export converted when the backfill converts it from raw/", async () => {
    const s3 = fakeS3(
      { ...LAKE, [FULL]: "2026-10-04T06:00:00.000Z" },
      { state: startedFull() },
    );
    const dynamo = fakeDynamo();
    expect(await run(s3, dynamo)).toEqual({
      backfilled: 4,
      failed: 0,
      finished: true,
    });
    expect(dynamo.starts).toEqual([]);
    expect(s3.state()).toMatchObject({ formatVersion: 2 });
  });

  it("keeps re-converting when the export can't start, and tries again next run", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    expect(
      await run(s3, fakeDynamo({ startFails: true }), {
        skip: [manifest("e3")],
      }),
    ).toEqual({ backfilled: 2, failed: 0, finished: false });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("PITR is off"),
    );
    expect(s3.state()).toMatchObject({ formatVersion: 1 });
    expect(s3.state().backfill.fullExport).toBeUndefined();

    const dynamo = fakeDynamo();
    await run(s3, dynamo);
    expect(dynamo.starts).toEqual([
      expect.objectContaining({ ClientToken: "format-2-1" }),
    ]);
  });

  it("logs a converter with no table ARN and keeps the old version", async () => {
    const s3 = fakeS3(LAKE, { state: { formatVersion: 1 } });
    const dynamo = fakeDynamo();
    const result = await backfillIfFormatChanged({
      send: s3.send,
      ddbSend: dynamo.send,
      tableArn: undefined,
      convert: recorder().convert,
      bucket: BUCKET,
      formatVersion: 2,
    });
    expect(result).toMatchObject({ finished: false });
    expect(dynamo.starts).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing DYNAMO_TABLE_ARN"),
    );
    expect(s3.state()).toMatchObject({ formatVersion: 1 });
  });

  it("starts a new export when a newer version replaces a started one", async () => {
    const s3 = fakeS3(LAKE, { state: startedFull() });
    const dynamo = fakeDynamo();
    await run(s3, dynamo, { formatVersion: 3, skip: [FULL] });
    expect(dynamo.starts).toEqual([
      expect.objectContaining({ ClientToken: "format-3-1" }),
    ]);
    expect(s3.state()).toMatchObject({ formatVersion: 1 });
  });
});
