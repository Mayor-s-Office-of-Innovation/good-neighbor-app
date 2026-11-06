import { test } from "vitest";
import assert from "node:assert/strict";
import { LINK_MS, createReportJobs, linkLeft } from "./report-job.js";

/** @param {string} state @param {Record<string, unknown>} [extra] */
const job = (state, extra = {}) => ({
  jobId: "j1",
  state,
  error: null,
  expiresAt: "2026-11-05T20:00:00.000Z",
  downloadUrl: state === "succeeded" ? "https://example.org/r.json" : null,
  result: state === "succeeded" ? { filename: "r.json" } : null,
  ...extra,
});

/**
 * A fake API whose job moves through `states`, one per status read.
 * @param {string[]} states
 */
function fakeApi(states) {
  /** @type {{ name: string, args: unknown[] }[]} */
  const calls = [];
  let read = 0;
  return {
    calls,
    api: {
      /** @param {Record<string, unknown>} body @param {string} key */
      async createInsightsReport(body, key) {
        calls.push({ name: "create", args: [body, key] });
        return { job: job("queued") };
      },
      async getReportJob(/** @type {string} */ id) {
        calls.push({ name: "get", args: [id] });
        return { job: job(states[Math.min(read++, states.length - 1)]) };
      },
    },
  };
}

const noWait = () => Promise.resolve();

test("a report polls until it's ready, then offers its file", async () => {
  const { api, calls } = fakeApi(["running", "succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  /** @type {string[]} */
  const phases = [];
  jobs.subscribe(() => phases.push(jobs.current?.phase ?? ""));
  await jobs.start(["s1", "s2"], { period: "month", month: "2026-10" });
  assert.deepEqual(phases, ["starting", "queued", "running", "succeeded"]);
  assert.equal(jobs.current?.job?.downloadUrl, "https://example.org/r.json");
  assert.deepEqual(calls[0].args[0], {
    siteIds: ["s1", "s2"],
    period: "month",
    month: "2026-10",
  });
});

test("each report sends a new idempotency key", async () => {
  const { api, calls } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  await jobs.start(["s1"], {});
  const keys = calls.filter((c) => c.name === "create").map((c) => c.args[1]);
  assert.equal(new Set(keys).size, 2);
});

test("a refused request shows the server's reason", async () => {
  const jobs = createReportJobs({
    api: {
      ...fakeApi([]).api,
      createInsightsReport: async () => {
        throw new Error("jobs_unavailable");
      },
    },
    wait: noWait,
  });
  await jobs.start(["s1"], {});
  assert.deepEqual(
    [jobs.current?.phase, jobs.current?.error],
    ["failed", "jobs_unavailable"],
  );
});

test("a failed job keeps the error it reported", async () => {
  const { api } = fakeApi([]);
  api.getReportJob = async () => ({
    job: job("failed", { error: "job_timed_out" }),
  });
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  assert.equal(jobs.current?.error, "job_timed_out");
});

test("a poll with no news tells no one, so the status isn't read out again", async () => {
  const { api } = fakeApi(["running", "running", "succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  /** @type {string[]} */
  const phases = [];
  jobs.subscribe(() => phases.push(jobs.current?.phase ?? ""));
  await jobs.start(["s1"], {});
  assert.deepEqual(phases, ["starting", "queued", "running", "succeeded"]);
});

test("one dropped status read doesn't fail a report that's still running", async () => {
  const { api } = fakeApi(["succeeded"]);
  const read = api.getReportJob;
  let reads = 0;
  api.getReportJob = async (id) => {
    if (++reads === 1) throw new Error("socket hang up");
    return read(id);
  };
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  assert.equal(jobs.current?.phase, "succeeded");
});

test("status reads that keep failing say so, back off and recover when the job ends", async () => {
  const { api } = fakeApi(["succeeded"]);
  const read = api.getReportJob;
  let reads = 0;
  api.getReportJob = async (id) => {
    if (++reads <= 5) throw new Error("socket hang up");
    return read(id);
  };
  /** @type {number[]} */
  const waits = [];
  const jobs = createReportJobs({
    api,
    wait: async (ms) => void waits.push(ms),
  });
  /** @type {string[]} */
  const told = [];
  jobs.subscribe(() =>
    told.push(`${jobs.current?.phase}:${jobs.current?.error ?? ""}`),
  );
  await jobs.start(["s1"], {});
  assert.deepEqual(told, [
    "starting:",
    "queued:",
    "queued:socket hang up",
    "succeeded:",
  ]);
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 30000, 30000]);
});

for (const code of ["job_not_found", "job_expired"])
  test(`a status read saying ${code} stops polling at once`, async () => {
    const { api, calls } = fakeApi([]);
    api.getReportJob = async (id) => {
      calls.push({ name: "get", args: [id] });
      throw new Error(code);
    };
    const jobs = createReportJobs({ api, wait: noWait });
    await jobs.start(["s1"], {});
    assert.deepEqual(
      [jobs.current?.phase, jobs.current?.error],
      ["failed", code],
    );
    assert.equal(calls.filter((c) => c.name === "get").length, 1);
  });

test("a ready report with no link yet can fetch one", async () => {
  const { api } = fakeApi([]);
  let reads = 0;
  api.getReportJob = async () => ({
    job: job("succeeded", ++reads === 1 ? { downloadUrl: null } : {}),
  });
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  assert.equal(jobs.current?.job?.downloadUrl, null);
  await jobs.refresh();
  assert.equal(jobs.current?.job?.downloadUrl, "https://example.org/r.json");
});

test("a ready report's link runs out before the report, and can be fetched again", async () => {
  const { api, calls } = fakeApi(["succeeded"]);
  let clock = 1_000;
  const jobs = createReportJobs({ api, wait: noWait, now: () => clock });
  await jobs.start(["s1"], {});
  assert.equal(linkLeft(jobs.current, clock), LINK_MS);
  clock += LINK_MS;
  assert.equal(linkLeft(jobs.current, clock), 0);
  await jobs.refresh();
  assert.equal(linkLeft(jobs.current, clock), LINK_MS);
  assert.equal(calls.filter((c) => c.name === "get").length, 2);
});

/**
 * A ready report whose next status read fails with `code`.
 * @param {string} code
 */
async function refreshFailing(code) {
  const { api } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  api.getReportJob = async () => {
    throw new Error(code);
  };
  await jobs.refresh();
  return jobs.current;
}

test("a fresh link that can't be fetched says so and can be tried again", async () => {
  const state = await refreshFailing("network");
  assert.deepEqual([state?.phase, state?.error], ["succeeded", "network"]);
});

test("a report the server no longer keeps can't get a fresh link", async () => {
  const state = await refreshFailing("job_not_found");
  assert.deepEqual([state?.phase, state?.error], ["failed", "job_not_found"]);
});

test("an expired report can't get a fresh link either", async () => {
  const state = await refreshFailing("job_expired");
  assert.deepEqual([state?.phase, state?.error], ["failed", "job_not_found"]);
});

test("a second failed try at a fresh link is told again", async () => {
  const { api } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  api.getReportJob = async () => {
    throw new Error("network");
  };
  /** @type {string[]} */
  const told = [];
  jobs.subscribe(() => told.push(jobs.current?.error ?? ""));
  await jobs.refresh();
  await jobs.refresh();
  assert.deepEqual(told, ["network", "", "network"]);
});

test("a fresh link from one try isn't undone by an older try failing", async () => {
  const { api } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  /** @type {(() => void)[]} */
  const fails = [];
  const good = api.getReportJob;
  api.getReportJob = () =>
    new Promise((_, reject) => fails.push(() => reject(new Error("network"))));
  const older = jobs.refresh();
  api.getReportJob = async (/** @type {string} */ id) => {
    const reply = await good(id);
    reply.job.downloadUrl = "https://example.org/fresh.json";
    return reply;
  };
  await jobs.refresh();
  fails[0]();
  await older;
  assert.deepEqual(
    [jobs.current?.error, jobs.current?.job?.downloadUrl],
    ["", "https://example.org/fresh.json"],
  );
});

test("Try again sends the same ask as the job that failed, with a new key", async () => {
  let fail = true;
  const { api, calls } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({
    api: {
      ...api,
      async createInsightsReport(body, key) {
        if (fail) throw new Error("jobs_unavailable");
        return api.createInsightsReport(body, key);
      },
    },
    wait: noWait,
  });
  await jobs.start(["s1"], { period: "month", month: "2026-10" });
  fail = false;
  await jobs.retry();
  assert.equal(jobs.current?.phase, "succeeded");
  assert.deepEqual(calls[0].args[0], {
    siteIds: ["s1"],
    period: "month",
    month: "2026-10",
  });
  assert.equal(jobs.current?.count, 1);
});

test("a dismissed job is gone, so its dialog isn't shown again", async () => {
  const { api } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  let told = 0;
  jobs.subscribe(() => (told += 1));
  await jobs.start(["s1"], {});
  const before = told;
  jobs.dismiss();
  assert.equal(jobs.current, null);
  assert.equal(told, before + 1);
});
