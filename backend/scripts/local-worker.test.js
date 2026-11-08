import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const { runJobs } = vi.hoisted(() => ({
  runJobs: vi.fn(async () => ({ batchItemFailures: [] })),
}));
vi.mock("../src/lambda/analytics-query.js", () => ({ runJobs }));

const { SQSClient } = await import("@aws-sdk/client-sqs");
const { createJobRunner, handleMessage, pickHandler } = await import(
  "./local-worker.mjs"
);
const { handler: processSubmission } = await import(
  "../src/workers/process-submission.js"
);
const { handler: analyzeArtifact } = await import(
  "../src/workers/analyze-artifact.js"
);
const { handler: sf311Job } = await import("../src/workers/sf311-job.js");

describe("pickHandler", () => {
  it("sends an Insights job to the code the jobs Lambda runs", async () => {
    const event = { Records: [] };
    const handler = pickHandler(
      JSON.stringify({ insightsJob: { ownerKey: "o", jobId: "j" } }),
    );
    await expect(
      handler(/** @type {any} */ (event), /** @type {any} */ ({}), () => {}),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(runJobs).toHaveBeenCalledWith(event);
  });

  it.each([
    ["a typed message", { type: "sf311_job" }, () => sf311Job],
    [
      "an analyze message",
      { artifactId: "a1", s3Key: "k" },
      () => analyzeArtifact,
    ],
    ["anything else", { submissionId: "s1" }, () => processSubmission],
  ])("routes %s by its shape", (_, message, expected) => {
    expect(pickHandler(JSON.stringify(message))).toBe(expected());
  });

  it("treats a body that isn't JSON as a submission", () => {
    expect(pickHandler("{")).toBe(processSubmission);
  });
});

describe("createJobRunner", () => {
  /** @returns {{ promise: Promise<void>, resolve: () => void }} */
  const deferred = () => {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((r) => {
      resolve = () => r(undefined);
    });
    return { promise, resolve };
  };

  it("runs two Insights jobs at a time, as the jobs Lambda does, and queues the rest", async () => {
    const runner = createJobRunner(2);
    const jobs = [deferred(), deferred(), deferred()];
    let started = 0;
    for (const job of jobs)
      runner.run(() => {
        started += 1;
        return job.promise;
      });
    await setImmediate();
    expect(started).toBe(2);
    jobs[0].resolve();
    await setImmediate();
    expect(started).toBe(3);
  });

  it("lets a stop wait for running and queued jobs, so none is cut off mid-run", async () => {
    const runner = createJobRunner(1);
    const jobs = [deferred(), deferred()];
    let finished = 0;
    for (const job of jobs)
      runner.run(async () => {
        await job.promise;
        finished += 1;
      });
    let drained = false;
    runner.drain().then(() => {
      drained = true;
    });
    jobs[0].resolve();
    await setImmediate();
    expect(drained).toBe(false);
    jobs[1].resolve();
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(finished).toBe(2);
  });

  it("keeps running the queue after a job throws", async () => {
    const runner = createJobRunner(1);
    let ran = false;
    runner.run(async () => {
      throw new Error("boom");
    });
    runner.run(async () => {
      ran = true;
    });
    await runner.drain();
    expect(ran).toBe(true);
  });
});

describe("handleMessage", () => {
  const msg = { MessageId: "m1", ReceiptHandle: "r1", Body: "{}" };

  it.each([
    ["deletes a message its handler finished", async () => undefined, 1],
    [
      "leaves a message its handler reported failed, for redelivery",
      async () => ({ batchItemFailures: [{ itemIdentifier: "m1" }] }),
      0,
    ],
    [
      "leaves a message whose handler threw, for redelivery",
      async () => {
        throw new Error("boom");
      },
      0,
    ],
  ])("%s", async (_, handler, deletes) => {
    const send = vi
      .spyOn(SQSClient.prototype, "send")
      .mockImplementation(async () => ({}));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMessage("q", msg, /** @type {any} */ (handler));
      expect(send).toHaveBeenCalledTimes(deletes);
      if (deletes)
        expect(/** @type {any} */ (send.mock.calls[0][0]).input).toEqual({
          QueueUrl: "q",
          ReceiptHandle: "r1",
        });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("entry check", () => {
  it("imports without argv[1], as `node -e` leaves it", async () => {
    const argv = process.argv;
    process.argv = [argv[0]];
    try {
      vi.resetModules();
      await expect(import("./local-worker.mjs")).resolves.toHaveProperty(
        "pickHandler",
      );
    } finally {
      process.argv = argv;
    }
  });
});
