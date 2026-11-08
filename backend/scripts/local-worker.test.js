import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const { runJobs, submit } = vi.hoisted(() => ({
  runJobs: vi.fn(async () => ({ batchItemFailures: [] })),
  submit: vi.fn(async () => {}),
}));
vi.mock("../src/lambda/analytics-query.js", () => ({ runJobs }));
// Stands in for a quick worker, so a batch test needs no DynamoDB.
vi.mock("../src/workers/process-submission.js", () => ({ handler: submit }));

const { SQSClient } = await import("@aws-sdk/client-sqs");
const { createJobRunner, handleBatch, handleMessage, pickHandler } =
  await import("./local-worker.mjs");
const { handler: processSubmission } = await import(
  "../src/workers/process-submission.js"
);
const { handler: analyzeArtifact } = await import(
  "../src/workers/analyze-artifact.js"
);
const { handler: sf311Job } = await import("../src/workers/sf311-job.js");

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
const deferred = () => {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
};

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
  it("runs two Insights jobs at a time, as the jobs Lambda does, and refuses a third", async () => {
    const runner = createJobRunner(2);
    const jobs = [deferred(), deferred()];
    expect(jobs.map((job) => runner.tryRun(() => job.promise))).toEqual([
      true,
      true,
    ]);
    expect(runner.tryRun(async () => {})).toBe(false);
    jobs[0].resolve();
    await setImmediate();
    expect(runner.tryRun(async () => {})).toBe(true);
    jobs[1].resolve();
    await runner.drain();
  });

  it("lets a stop wait for running jobs, so none is cut off mid-run", async () => {
    const runner = createJobRunner(1);
    const job = deferred();
    let finished = false;
    runner.tryRun(async () => {
      await job.promise;
      finished = true;
    });
    let drained = false;
    runner.drain().then(() => {
      drained = true;
    });
    await setImmediate();
    expect(drained).toBe(false);
    job.resolve();
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(finished).toBe(true);
  });

  it("frees a slot when a job throws", async () => {
    const runner = createJobRunner(1);
    runner.tryRun(async () => {
      throw new Error("boom");
    });
    await runner.drain();
    expect(runner.tryRun(async () => {})).toBe(true);
  });
});

describe("handleBatch", () => {
  const insightsMsg = (/** @type {string} */ id) => ({
    MessageId: id,
    ReceiptHandle: `r-${id}`,
    Body: JSON.stringify({ insightsJob: { ownerKey: "o", jobId: id } }),
  });

  it("moves on while Insights jobs run, so photo analysis isn't held up", async () => {
    vi.spyOn(SQSClient.prototype, "send").mockImplementation(async () => ({}));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = deferred();
    runJobs.mockImplementation(async () => {
      await gate.promise;
      return { batchItemFailures: [] };
    });
    const runner = createJobRunner(2);
    try {
      await handleBatch(
        "q",
        [
          insightsMsg("j1"),
          { MessageId: "m1", ReceiptHandle: "r1", Body: "{}" },
        ],
        runner,
      );
      expect(submit).toHaveBeenCalledOnce();
      // The job loads its code first, so it starts a moment later.
      await vi.waitFor(() => expect(runJobs).toHaveBeenCalledOnce());
    } finally {
      gate.resolve();
      await runner.drain();
      runJobs.mockReset();
      submit.mockClear();
      vi.restoreAllMocks();
    }
  });

  it("hands a job back to the queue when the runner is full, rather than hold it past its visibility timeout", async () => {
    const send = vi
      .spyOn(SQSClient.prototype, "send")
      .mockImplementation(async () => ({}));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = deferred();
    runJobs.mockImplementation(async () => {
      await gate.promise;
      return { batchItemFailures: [] };
    });
    // One slot, so one job fills it, as two do in the worker.
    const runner = createJobRunner(1);
    try {
      await handleBatch("q", [insightsMsg("j1"), insightsMsg("j2")], runner);
      await vi.waitFor(() => expect(runJobs).toHaveBeenCalledOnce());
      expect(
        send.mock.calls.map(([cmd]) => [
          cmd.constructor.name,
          /** @type {any} */ (cmd).input.ReceiptHandle,
        ]),
      ).toEqual([["ChangeMessageVisibilityCommand", "r-j2"]]);
    } finally {
      gate.resolve();
      await runner.drain();
      runJobs.mockReset();
      vi.restoreAllMocks();
    }
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
