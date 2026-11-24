import { describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { setImmediate } from "node:timers";
import { inProcessStarter, s3JobStore, sqsStarter } from "./job-store.js";

/**
 * A fake S3 that keeps objects by key and honours IfNoneMatch and IfMatch.
 * @returns {{ send: (cmd: any) => Promise<any>, objects: Map<string, any>, sent: any[] }}
 */
function fakeS3() {
  const objects = new Map();
  /** @type {Map<string, string>} */
  const etags = new Map();
  let writes = 0;
  /** @type {any[]} */
  const sent = [];
  return {
    objects,
    sent,
    async send(cmd) {
      const input = cmd.input;
      sent.push({ name: cmd.constructor.name, input });
      if (cmd.constructor.name === "PutObjectCommand") {
        if (
          (input.IfNoneMatch === "*" && objects.has(input.Key)) ||
          (input.IfMatch && etags.get(input.Key) !== input.IfMatch)
        )
          throw Object.assign(new Error("PreconditionFailed"), {
            $metadata: { httpStatusCode: 412 },
          });
        objects.set(input.Key, input.Body);
        etags.set(input.Key, `"e${(writes += 1)}"`);
        return { ETag: etags.get(input.Key) };
      }
      if (cmd.constructor.name === "GetObjectCommand") {
        if (!objects.has(input.Key))
          throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        const body = objects.get(input.Key);
        return {
          Body: { transformToString: async () => body },
          ETag: etags.get(input.Key),
        };
      }
      if (cmd.constructor.name === "DeleteObjectCommand") {
        objects.delete(input.Key);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
}

const record = /** @type {any} */ ({ jobId: "j1", state: "queued" });

describe("s3JobStore", () => {
  it("keeps each requester's jobs under their own prefix", async () => {
    const s3 = fakeS3();
    const store = s3JobStore({ s3, bucket: "lake" });
    await store.create("owner1", "j1", record);
    expect([...s3.objects.keys()]).toEqual(["insights-jobs/owner1/j1.json"]);
    expect(await store.get("owner2", "j1")).toBeNull();
  });

  it("creates a job only once for the same key", async () => {
    const store = s3JobStore({ s3: fakeS3(), bucket: "lake" });
    expect(await store.create("o", "j1", record)).toBe(true);
    expect(await store.create("o", "j1", record)).toBe(false);
  });

  it("reads back a stored job", async () => {
    const store = s3JobStore({ s3: fakeS3(), bucket: "lake" });
    await store.put("o", "j1", record);
    expect(await store.get("o", "j1")).toEqual(record);
  });

  it("writes over a job only at the version it read", async () => {
    const store = s3JobStore({ s3: fakeS3(), bucket: "lake" });
    await store.create("o", "j1", record);
    const read = /** @type {any} */ (await store.read("o", "j1"));
    const running = { ...record, state: "running" };
    expect(await store.put("o", "j1", running, read.version)).toBeTruthy();
    expect(
      await store.put(
        "o",
        "j1",
        { ...record, state: "cancelled" },
        read.version,
      ),
    ).toBeNull();
    expect(await store.get("o", "j1")).toEqual(running);
  });

  it("passes on S3 failures other than a lost race or a missing job", async () => {
    const denied = Object.assign(new Error("AccessDenied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const store = s3JobStore({
      s3: {
        send: async () => {
          throw denied;
        },
      },
      bucket: "lake",
    });
    await expect(store.create("o", "j1", record)).rejects.toBe(denied);
    await expect(store.get("o", "j1")).rejects.toBe(denied);
  });

  it("stores a job's file next to its record, and deletes only the file", async () => {
    const s3 = fakeS3();
    const store = s3JobStore({ s3, bucket: "lake" });
    await store.put("o", "j1", record);
    await store.putResult("o", "j1", "a,b\n", "text/csv");
    expect(s3.sent.at(-1).input).toMatchObject({
      Key: "insights-jobs/o/j1.out",
      ContentType: "text/csv",
    });
    await store.deleteResult("o", "j1");
    expect([...s3.objects.keys()]).toEqual(["insights-jobs/o/j1.json"]);
  });

  it("signs a download link that expires and names the file safely", async () => {
    const presignClient = new S3Client({
      region: "us-west-2",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example" },
    });
    const store = s3JobStore({ s3: fakeS3(), presignClient, bucket: "lake" });
    const url = new URL(await store.resultUrl("o", "j1", 'a"b.csv', 300));
    expect(url.pathname).toBe("/insights-jobs/o/j1.out");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="a_b.csv"',
    );
  });
});

describe("sqsStarter", () => {
  it("queues the job reference", async () => {
    const sqs = fakeS3();
    sqs.send = async (cmd) => {
      sqs.sent.push(cmd.input);
      return {};
    };
    await sqsStarter({ sqs, queueUrl: "q" })({ ownerKey: "o", jobId: "j1" });
    expect(sqs.sent).toEqual([
      {
        QueueUrl: "q",
        MessageBody: JSON.stringify({
          insightsJob: { ownerKey: "o", jobId: "j1" },
        }),
      },
    ]);
  });
});

describe("inProcessStarter", () => {
  /** Lets the starter's setImmediate callback and the job's promise settle. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("runs the job after replying, and logs a failure instead of crashing", async () => {
    /** @type {string[]} */
    const ran = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = inProcessStarter(() => async (ref) => {
        ran.push(ref.jobId);
        throw new Error("boom");
      });
      await start({ ownerKey: "o", jobId: "j1" });
      expect(ran).toEqual([]);
      await settle();
      await settle();
      expect(ran).toEqual(["j1"]);
      expect(error).toHaveBeenCalledWith(
        "[insights] local job failed",
        expect.objectContaining({ message: "boom" }),
      );
    } finally {
      error.mockRestore();
    }
  });
});
