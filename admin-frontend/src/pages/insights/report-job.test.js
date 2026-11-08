import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  LINK_MS,
  MAX_FOLLOW_MS,
  createReportJobs,
  linkLeft,
} from "./report-job.js";

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

test("a fresh read with no link says so, so Download isn't left doing nothing", async () => {
  const { api } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  api.getReportJob = async () => ({
    job: job("succeeded", { downloadUrl: null }),
  });
  await jobs.refresh();
  assert.deepEqual(
    [jobs.current?.phase, jobs.current?.error],
    ["succeeded", "link_missing"],
  );
});

test("a link lasts as long as the server says, less a minute", async () => {
  const { api } = fakeApi([]);
  api.getReportJob = async () => ({
    job: job("succeeded", { downloadSeconds: 120 }),
  });
  let clock = 5_000;
  const jobs = createReportJobs({ api, wait: noWait, now: () => clock });
  await jobs.start(["s1"], {});
  assert.equal(linkLeft(jobs.current, clock), 60_000);
  assert.equal(jobs.linkFresh(), true);
  clock += 60_000;
  assert.equal(jobs.linkFresh(), false);
});

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

test("Try again sends the same ask and key, so a job made before a lost reply isn't made twice", async () => {
  let fail = true;
  const { api, calls } = fakeApi(["succeeded"]);
  /** @type {string[]} */
  const keys = [];
  const jobs = createReportJobs({
    api: {
      ...api,
      async createInsightsReport(body, key) {
        keys.push(key);
        if (fail) throw new Error("request_timeout");
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
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);
});

test("Try again on a cancelled job asks with a new key, since the old one answers cancelled", async () => {
  const { api, calls } = fakeApi(["cancelled", "succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  assert.equal(jobs.current?.phase, "cancelled");
  await jobs.retry();
  const keys = calls.filter((c) => c.name === "create").map((c) => c.args[1]);
  assert.equal(new Set(keys).size, 2);
});

test("a key is made without randomUUID, which plain-http pages lack", async () => {
  const { api, calls } = fakeApi(["succeeded"]);
  vi.stubGlobal("crypto", {
    getRandomValues: (/** @type {Uint8Array} */ bytes) => bytes.fill(171),
  });
  const jobs = createReportJobs({ api, wait: noWait });
  await jobs.start(["s1"], {});
  assert.equal(jobs.current?.phase, "succeeded");
  assert.match(String(calls[0].args[1]), /^[A-Za-z0-9_-]{8,128}$/);
});

test("a status read that times out keeps its code, not its sentence", async () => {
  const { api } = fakeApi(["succeeded"]);
  const read = api.getReportJob;
  let reads = 0;
  api.getReportJob = async (id) => {
    if (++reads <= 3)
      throw Object.assign(new Error("It took too long to answer."), {
        code: "request_timeout",
      });
    return read(id);
  };
  const jobs = createReportJobs({ api, wait: noWait });
  /** @type {string[]} */
  const errors = [];
  jobs.subscribe(() => errors.push(jobs.current?.error ?? ""));
  await jobs.start(["s1"], {});
  assert.deepEqual(errors, ["", "", "request_timeout", ""]);
});

for (const status of [400, 403, 404])
  test(`a status read refused with ${status} stops polling at once`, async () => {
    const { api, calls } = fakeApi([]);
    api.getReportJob = async (id) => {
      calls.push({ name: "get", args: [id] });
      throw Object.assign(new Error("request_blocked"), { status });
    };
    let clock = 0;
    const jobs = createReportJobs({
      api,
      now: () => clock,
      wait: async (ms) => void (clock += ms),
    });
    await jobs.start(["s1"], {});
    assert.deepEqual(
      [jobs.current?.phase, jobs.current?.error],
      ["failed", "request_blocked"],
    );
    assert.equal(calls.filter((c) => c.name === "get").length, 1);
  });

for (const status of [408, 429, 503])
  test(`a status read refused with ${status} is asked again`, async () => {
    const { api } = fakeApi(["succeeded"]);
    const read = api.getReportJob;
    let reads = 0;
    api.getReportJob = async (id) => {
      if (++reads === 1) throw Object.assign(new Error("busy"), { status });
      return read(id);
    };
    const jobs = createReportJobs({ api, wait: noWait });
    await jobs.start(["s1"], {});
    assert.equal(jobs.current?.phase, "succeeded");
  });

test("a job that never ends stops being followed after the server's own limits", async () => {
  const { api, calls } = fakeApi([]);
  let clock = 0;
  api.getReportJob = async (id) => {
    calls.push({ name: "get", args: [id] });
    // Long past the limit, so following it that far is the failure.
    return { job: job(clock > 2 * MAX_FOLLOW_MS ? "succeeded" : "queued") };
  };
  const jobs = createReportJobs({
    api,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  });
  await jobs.start(["s1"], {});
  assert.deepEqual(
    [jobs.current?.phase, jobs.current?.error],
    ["failed", "job_timed_out"],
  );
  assert.ok(clock > MAX_FOLLOW_MS);
  const reads = calls.filter((c) => c.name === "get").length;
  assert.equal(reads, Math.ceil(MAX_FOLLOW_MS / 2000) + 1);
});

test("a hidden tab doesn't poll until it's shown", async () => {
  const { api, calls } = fakeApi(["succeeded"]);
  /** @type {() => void} */
  let show = () => {};
  const jobs = createReportJobs({
    api,
    wait: noWait,
    visible: () => new Promise((resolve) => (show = () => resolve(undefined))),
  });
  const started = jobs.start(["s1"], {});
  await vi.waitFor(() => assert.equal(jobs.current?.phase, "queued"));
  assert.equal(calls.filter((c) => c.name === "get").length, 0);
  show();
  await started;
  assert.equal(jobs.current?.phase, "succeeded");
});

test("a poll that lands after the job was dismissed changes nothing", async () => {
  const { api, calls } = fakeApi(["succeeded"]);
  /** @type {() => void} */
  let release = () => {};
  const jobs = createReportJobs({
    api,
    wait: () => new Promise((resolve) => (release = () => resolve())),
  });
  const started = jobs.start(["s1"], {});
  await vi.waitFor(() => assert.equal(jobs.current?.phase, "queued"));
  jobs.dismiss();
  release();
  await started;
  assert.equal(jobs.current, null);
  assert.equal(calls.filter((c) => c.name === "get").length, 0);
});

test("a status read already under way when the job is dismissed doesn't bring it back", async () => {
  /** @type {(value: { job: any }) => void} */
  let answer = () => {};
  const jobs = createReportJobs({
    api: {
      createInsightsReport: async () => ({ job: job("queued") }),
      getReportJob: () => new Promise((resolve) => (answer = resolve)),
    },
    wait: noWait,
  });
  let told = 0;
  jobs.subscribe(() => (told += 1));
  const started = jobs.start(["s1"], {});
  await vi.waitFor(() => assert.equal(jobs.current?.phase, "queued"));
  jobs.dismiss();
  const before = told;
  answer({ job: job("succeeded") });
  await started;
  assert.deepEqual([jobs.current, told], [null, before]);
});

test("when the first report answers after a second was started, only the second is followed", async () => {
  /** @type {((value: { job: any }) => void)[]} */
  const answers = [];
  /** @type {string[]} */
  const followed = [];
  const jobs = createReportJobs({
    api: {
      createInsightsReport: () =>
        new Promise((resolve) => answers.push(resolve)),
      async getReportJob(/** @type {string} */ id) {
        followed.push(id);
        return { job: job("succeeded", { jobId: id }) };
      },
    },
    wait: noWait,
  });
  const first = jobs.start(["s1"], {});
  const second = jobs.start(["s1", "s2"], {});
  assert.deepEqual([jobs.current?.phase, jobs.current?.count], ["starting", 2]);
  answers[0]({ job: job("queued", { jobId: "first" }) });
  await first;
  answers[1]({ job: job("queued", { jobId: "second" }) });
  await second;
  assert.deepEqual(followed, ["second"]);
  assert.deepEqual(
    [jobs.current?.job?.jobId, jobs.current?.count],
    ["second", 2],
  );
});

test("a listener that throws doesn't turn a report into a failed one, or stop the others", async () => {
  const { api } = fakeApi(["succeeded"]);
  const jobs = createReportJobs({ api, wait: noWait });
  /** @type {string[]} */
  const seen = [];
  const thrown = vi.spyOn(console, "error").mockImplementation(() => {});
  jobs.subscribe(() => {
    throw new Error("listener bug");
  });
  jobs.subscribe(() => seen.push(jobs.current?.phase ?? ""));
  await jobs.start(["s1"], {});
  thrown.mockRestore();
  assert.equal(jobs.current?.phase, "succeeded");
  assert.deepEqual(seen, ["starting", "queued", "succeeded"]);
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
