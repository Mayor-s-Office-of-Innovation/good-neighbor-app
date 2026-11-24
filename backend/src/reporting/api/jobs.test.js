import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { JOB_LIMITS, createJobs, memoryJobStore } from "./jobs.js";
import { requestError } from "./requests.js";

const T0 = Date.parse("2026-11-04T20:00:00.000Z");

/**
 * @param {{ render?: any, starter?: any, onError?: any, current?: any }} [opts]
 */
function setup(opts = {}) {
  const clock = { now: T0 };
  const store = memoryJobStore();
  /** @type {{ ownerKey: string, jobId: string }[]} */
  const started = [];
  const snapshot = {
    prefix: "p1",
    snapshotId: "snap1",
    manifest: { evaluatedAt: "2026-11-04T19:00:00.000Z" },
  };
  const byPrefix = vi.fn(async () => /** @type {any} */ (snapshot));
  const jobs = createJobs({
    store,
    snapshots: {
      current: opts.current ?? (async () => /** @type {any} */ (snapshot)),
      byPrefix,
    },
    render:
      opts.render ??
      (async () => ({
        body: "a,b\r\n",
        contentType: "text/csv",
        filename: "insights.csv",
        rows: 1,
        dataQuality: { state: "ok" },
      })),
    starter:
      opts.starter ??
      (async (/** @type {any} */ ref) => {
        started.push(ref);
      }),
    now: () => clock.now,
    onError: opts.onError,
    // No real waiting in tests; the race retry's pause is S3's to need.
    wait: async () => {},
  });
  const request = {
    kind: /** @type {const} */ ("export"),
    params: { dataset: "issues" },
  };
  return { clock, store, jobs, started, request, byPrefix };
}

describe("createJobs", () => {
  it("queues a job and starts it in the background", async () => {
    const { jobs, started, request } = setup();
    const res = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    expect(res.statusCode).toBe(202);
    expect(res.job).toMatchObject({ state: "queued", snapshotId: "snap1" });
    expect(started).toEqual([{ ownerKey: "owner1", jobId: res.job.jobId }]);
  });

  it("returns the same job for a repeated request with the same key", async () => {
    const { jobs, started, request } = setup();
    const first = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const again = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    expect(again.statusCode).toBe(200);
    expect(again.job.jobId).toBe(first.job.jobId);
    expect(started).toHaveLength(1);
  });

  it("refuses a key reused for a different request", async () => {
    const { jobs, request } = setup();
    await jobs.create("owner1", { ...request, idempotencyKey: "k1" });
    await expect(
      jobs.create("owner1", {
        kind: /** @type {const} */ ("export"),
        params: { dataset: "checks" },
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({
      code: "idempotency_key_reused",
      statusCode: 409,
    });
  });

  it("keeps each requester's jobs private, even with the same key", async () => {
    const { jobs, request } = setup();
    const mine = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await expect(jobs.get("owner2", mine.job.jobId)).rejects.toMatchObject({
      code: "job_not_found",
      statusCode: 404,
    });
    const theirs = await jobs.create("owner2", {
      ...request,
      idempotencyKey: "k1",
    });
    expect(theirs.job.jobId).not.toBe(mine.job.jobId);
  });

  it("runs a job to a file the requester gets a short-lived link to", async () => {
    const { jobs, request, byPrefix } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    const done = await jobs.get("owner1", job.jobId);
    expect(done).toMatchObject({
      state: "succeeded",
      result: { filename: "insights.csv", rows: 1 },
    });
    expect(done.downloadUrl).toMatch(/^memory:\/\//);
    expect(done.downloadSeconds).toBe(JOB_LIMITS.downloadSeconds);
    // With the ID, so a rebuilt folder at the same path isn't mistaken for it.
    expect(byPrefix).toHaveBeenCalledWith("p1", "snap1");
  });

  it("marks a job failed with a reason, and offers no file", async () => {
    const { jobs, request } = setup({
      render: async () => {
        throw requestError("export_too_large", 413);
      },
    });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(await jobs.get("owner1", job.jobId)).toMatchObject({
      state: "failed",
      error: "export_too_large",
      downloadUrl: null,
      downloadSeconds: null,
    });
  });

  it("logs a network error and shows the requester only job_failed", async () => {
    const onError = vi.fn();
    const { jobs, request } = setup({
      onError,
      render: async () => {
        throw Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        });
      },
    });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect((await jobs.get("owner1", job.jobId)).error).toBe("job_failed");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("checks a new request against the snapshot the job will read", async () => {
    const newer = { prefix: "p2", snapshotId: "snap2", manifest: {} };
    const { jobs, request } = setup({ current: async () => newer });
    const check = vi.fn();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
      check,
    });
    expect([check.mock.calls[0][0], job.snapshotId]).toEqual([newer, "snap2"]);
  });

  it("queues nothing when the check refuses the request", async () => {
    const { jobs, store, started, request } = setup();
    const check = () => {
      throw requestError("too_big", 413);
    };
    await expect(
      jobs.create("owner1", { ...request, idempotencyKey: "k1", check }),
    ).rejects.toMatchObject({ code: "too_big" });
    expect([store.records.size, started.length]).toEqual([0, 0]);
  });

  it("skips the check for a repeat of a known key", async () => {
    const { jobs, request } = setup();
    const check = vi.fn();
    await jobs.create("owner1", { ...request, idempotencyKey: "k1", check });
    await jobs.create("owner1", { ...request, idempotencyKey: "k1", check });
    expect(check).toHaveBeenCalledOnce();
  });

  it("gives up with 409 when the same key keeps losing the create race", async () => {
    const { jobs, store, request } = setup();
    store.create = async () => false;
    await expect(
      jobs.create("owner1", { ...request, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "job_busy", statusCode: 409 });
  });

  it("retries a failed job when the same request comes again", async () => {
    let fail = true;
    const { jobs, clock, started, request } = setup({
      render: async () => {
        if (fail) throw new Error("boom");
        return {
          body: "x",
          contentType: "text/csv",
          filename: "f.csv",
          rows: 0,
        };
      },
    });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    fail = false;
    clock.now = T0 + 60_000;
    const retry = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    expect(retry).toMatchObject({ statusCode: 202, job: { state: "queued" } });
    // A full day from the retry, so a late retry isn't gone on arrival.
    expect(Date.parse(retry.job.expiresAt)).toBe(clock.now + JOB_LIMITS.ttlMs);
    expect(started).toHaveLength(2);
    await jobs.run(started[1]);
    expect((await jobs.get("owner1", job.jobId)).state).toBe("succeeded");
  });

  it("starts a new job when a key comes back after its job expired", async () => {
    const { jobs, clock, started, request } = setup();
    await jobs.create("owner1", { ...request, idempotencyKey: "k1" });
    clock.now = T0 + JOB_LIMITS.ttlMs + 1;
    const again = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    expect(again).toMatchObject({ statusCode: 202, job: { state: "queued" } });
    expect(started).toHaveLength(2);
  });

  it("never writes a file for a job cancelled before it ran", async () => {
    const render = vi.fn();
    const { jobs, store, request } = setup({ render });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    expect((await jobs.cancel("owner1", job.jobId)).state).toBe("cancelled");
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(render).not.toHaveBeenCalled();
    expect(store.results.size).toBe(0);
  });

  it("drops the file of a job cancelled while it ran", async () => {
    /** @type {any} */
    let jobsRef;
    const { jobs, store, request } = setup({
      render: async () => {
        await jobsRef.cancel("owner1", jobId);
        return {
          body: "x",
          contentType: "text/csv",
          filename: "f.csv",
          rows: 0,
        };
      },
    });
    jobsRef = jobs;
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const jobId = job.jobId;
    await jobs.run({ ownerKey: "owner1", jobId });
    expect((await jobs.get("owner1", jobId)).state).toBe("cancelled");
    expect(store.results.size).toBe(0);
  });

  it("takes back the file of a job cancelled while the file was written", async () => {
    const { jobs, store, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const putResult = store.putResult.bind(store);
    store.putResult = async (owner, jobId, body, type) => {
      await putResult(owner, jobId, body, type);
      await jobs.cancel(owner, jobId);
    };
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect((await jobs.get("owner1", job.jobId)).state).toBe("cancelled");
    expect(store.results.size).toBe(0);
  });

  it.each([
    ["before its run marks it running", "running"],
    ["just before its run marks it succeeded", "succeeded"],
  ])(
    "keeps a job cancelled %s, with no file left",
    async (_name, interruptedState) => {
      const { jobs, store, request } = setup();
      const { job } = await jobs.create("owner1", {
        ...request,
        idempotencyKey: "k1",
      });
      const put = store.put.bind(store);
      let cancelled = false;
      store.put = async (owner, jobId, record, version) => {
        if (record.state === interruptedState && !cancelled) {
          cancelled = true;
          await jobs.cancel(owner, jobId);
        }
        return put(owner, jobId, record, version);
      };
      await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
      expect((await jobs.get("owner1", job.jobId)).state).toBe("cancelled");
      expect(store.results.size).toBe(0);
    },
  );

  it("won't cancel a finished job", async () => {
    const { jobs, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    await expect(jobs.cancel("owner1", job.jobId)).rejects.toMatchObject({
      code: "job_finished",
      statusCode: 409,
    });
  });

  it("reports a running job that stopped answering as timed out", async () => {
    const { jobs, store, clock, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const record = /** @type {any} */ (await store.get("owner1", job.jobId));
    await store.put("owner1", job.jobId, { ...record, state: "running" });
    clock.now = T0 + JOB_LIMITS.stallMs + 1;
    expect(await jobs.get("owner1", job.jobId)).toMatchObject({
      state: "failed",
      error: "job_timed_out",
    });
  });

  it("lets a job wait in a busy queue longer than a run may stall", async () => {
    const { jobs, clock, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    clock.now = T0 + JOB_LIMITS.stallMs + 1;
    expect((await jobs.get("owner1", job.jobId)).state).toBe("queued");
    clock.now = T0 + JOB_LIMITS.queueWaitMs + 1;
    expect(await jobs.get("owner1", job.jobId)).toMatchObject({
      state: "failed",
      error: "job_timed_out",
    });
  });

  it("starts over a job a dead attempt left running", async () => {
    const { jobs, store, clock, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const record = /** @type {any} */ (await store.get("owner1", job.jobId));
    await store.put("owner1", job.jobId, { ...record, state: "running" });
    clock.now = T0 + JOB_LIMITS.stallMs + 1;
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect((await jobs.get("owner1", job.jobId)).state).toBe("succeeded");
  });

  it("reruns a job a status poll timed out, so a job that always dies still reaches the DLQ", async () => {
    const { jobs, store, clock, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const record = /** @type {any} */ (await store.get("owner1", job.jobId));
    await store.put("owner1", job.jobId, { ...record, state: "running" });
    clock.now = T0 + JOB_LIMITS.stallMs + 1;
    await jobs.get("owner1", job.jobId);
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(await jobs.get("owner1", job.jobId)).toMatchObject({
      state: "succeeded",
      error: null,
    });
  });

  it("reruns a job that timed out in the queue when its failed first delivery comes back", async () => {
    const { jobs, store, clock, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const put = store.put;
    store.put = async () => {
      throw new Error("S3 is down");
    };
    await expect(
      jobs.run({ ownerKey: "owner1", jobId: job.jobId }),
    ).rejects.toThrow("S3 is down");
    store.put = put;
    clock.now = T0 + JOB_LIMITS.queueWaitMs + 1;
    expect((await jobs.get("owner1", job.jobId)).error).toBe("job_timed_out");
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(await jobs.get("owner1", job.jobId)).toMatchObject({
      state: "succeeded",
      error: null,
    });
  });

  it("keeps a job cancelled after it timed out in the queue", async () => {
    let renders = 0;
    const { jobs, clock, request } = setup({
      render: async () => {
        renders += 1;
        return { body: "x", contentType: "text/csv", filename: "f", rows: 1 };
      },
    });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    clock.now = T0 + JOB_LIMITS.queueWaitMs + 1;
    expect(await jobs.cancel("owner1", job.jobId)).toMatchObject({
      state: "cancelled",
      error: null,
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(renders).toBe(0);
  });

  it("keeps a timed-out run cancelled, so its redelivery doesn't rerun it", async () => {
    let renders = 0;
    const { jobs, store, clock, request } = setup({
      render: async () => {
        renders += 1;
        return { body: "x", contentType: "text/csv", filename: "f", rows: 1 };
      },
    });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const record = /** @type {any} */ (await store.get("owner1", job.jobId));
    await store.put("owner1", job.jobId, { ...record, state: "running" });
    clock.now = T0 + JOB_LIMITS.stallMs + 1;
    expect(await jobs.cancel("owner1", job.jobId)).toMatchObject({
      state: "cancelled",
      error: null,
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(renders).toBe(0);
    expect((await jobs.get("owner1", job.jobId)).state).toBe("cancelled");
  });

  it("doesn't rerun a job that failed with its own error", async () => {
    let renders = 0;
    const { jobs, request } = setup({
      render: async () => {
        renders += 1;
        throw new Error("render broke");
      },
    });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(renders).toBe(1);
  });

  it("gives up on a run only after the jobs Lambda's timeout, and before SQS redelivers it", () => {
    const terraform = readFileSync(
      new URL("../../../../infra/modules/app/insights.tf", import.meta.url),
      "utf8",
    );
    const seconds = (/** @type {RegExp} */ pattern) =>
      Number(pattern.exec(terraform)?.[1]) * 1000;
    const lambda = seconds(
      /"aws_lambda_function" "insights_jobs"[\s\S]*?\n {2}timeout\s*=\s*(\d+)/,
    );
    const visibility = seconds(
      /"aws_sqs_queue" "insights_jobs" \{[\s\S]*?\n {2}visibility_timeout_seconds\s*=\s*(\d+)/,
    );
    expect(lambda).toBeLessThan(JOB_LIMITS.stallMs);
    expect(JOB_LIMITS.stallMs).toBeLessThan(visibility);
  });

  it("keeps a job cancelled when its build then fails", async () => {
    /** @type {any} */
    let jobsRef;
    const { jobs, request } = setup({
      render: async () => {
        await jobsRef.cancel("owner1", jobId);
        throw new Error("render broke");
      },
    });
    jobsRef = jobs;
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    const jobId = job.jobId;
    await jobs.run({ ownerKey: "owner1", jobId });
    expect((await jobs.get("owner1", jobId)).state).toBe("cancelled");
  });

  it("answers 410 once a job has expired", async () => {
    const { jobs, clock, request } = setup();
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    clock.now = T0 + JOB_LIMITS.ttlMs + 1;
    await expect(jobs.get("owner1", job.jobId)).rejects.toMatchObject({
      code: "job_expired",
      statusCode: 410,
    });
  });

  it("marks a job failed and answers 503 when it can't be started", async () => {
    const { jobs, store, request } = setup({
      starter: async () => {
        throw new Error("queue down");
      },
    });
    await expect(
      jobs.create("owner1", { ...request, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "job_start_failed", statusCode: 503 });
    const [record] = [...store.records.values()];
    expect(record).toMatchObject({
      state: "failed",
      error: "job_start_failed",
    });
  });

  it("runs a duplicate delivery of the same job only once", async () => {
    const render = vi.fn(async () => ({
      body: "x",
      contentType: "text/csv",
      filename: "f.csv",
      rows: 0,
    }));
    const { jobs, request } = setup({ render });
    const { job } = await jobs.create("owner1", {
      ...request,
      idempotencyKey: "k1",
    });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    await jobs.run({ ownerKey: "owner1", jobId: job.jobId });
    expect(render).toHaveBeenCalledTimes(1);
  });
});
