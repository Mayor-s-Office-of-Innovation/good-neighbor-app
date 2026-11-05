// Lives outside the page, so leaving Overview and coming back still shows
// how the report is going.

/** @typedef {{ jobId: string, state: string, error: string | null, expiresAt: string, downloadUrl: string | null, result: { filename: string } | null }} Job */
/** @typedef {{ phase: "starting" | "queued" | "running" | "succeeded" | "failed" | "cancelled", siteCount: number, job: Job | null, error: string, linkAt?: number }} ReportState */
/**
 * @typedef {{
 *   createInsightsReport: (body: Record<string, unknown>, key: string) => Promise<{ job: Job }>,
 *   getReportJob: (id: string) => Promise<{ job: Job }>,
 *   cancelReportJob: (id: string) => Promise<{ job: Job }>,
 * }} ReportApi
 */

const DONE = new Set(["succeeded", "failed", "cancelled"]);
// The server no longer has the report, so asking again can't help.
const GONE = new Set(["job_not_found", "job_expired"]);
// Missed reads before the page says it can't check; the job runs on, so polling does too.
const MAX_MISSED_POLLS = 3;
// Slower polls while reads fail, so an outage isn't hit every 2 seconds.
const MAX_POLL_MS = 30_000;
// The server signs a download link for 5 minutes (JOB_LIMITS.downloadSeconds).
export const LINK_MS = 4 * 60 * 1000;

/** @param {ReportState | null} state @param {number} now @returns {number} ms until the link needs fetching again */
export const linkLeft = (state, now) =>
  state?.phase === "succeeded" && state.linkAt !== undefined
    ? Math.max(0, state.linkAt + LINK_MS - now)
    : 0;

/** @param {ReportState | null} a @param {ReportState} b */
const same = (a, b) =>
  !!a &&
  a.phase === b.phase &&
  a.error === b.error &&
  a.job?.state === b.job?.state &&
  a.job?.downloadUrl === b.job?.downloadUrl &&
  a.linkAt === b.linkAt;

/** @param {{ api: ReportApi, wait?: (ms: number) => Promise<void>, pollMs?: number, now?: () => number }} deps */
export function createReportJobs({
  api,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 2000,
  now = Date.now,
}) {
  /** @type {ReportState | null} */
  let current = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  // Each start gets its own run, so an old poll can't overwrite a new report.
  let run = 0;

  /** @param {ReportState} next @param {number} mine */
  const set = (next, mine) => {
    // A poll with no news mustn't redraw the bar or repeat its announcement.
    if (mine !== run || same(current, next)) return;
    current = next;
    for (const listener of listeners) listener();
  };

  /** @param {unknown} err */
  const codeOf = (err) =>
    err instanceof Error && err.message ? err.message : "job_failed";

  /** @param {Job} job @param {number} siteCount */
  const ended = (job, siteCount) =>
    /** @type {ReportState} */ ({
      phase: job.state,
      siteCount,
      job,
      error: job.error || "",
      linkAt: job.downloadUrl ? now() : undefined,
    });

  /** @param {Job} job @param {number} siteCount @param {number} mine */
  const follow = async (job, siteCount, mine) => {
    let latest = job;
    let missed = 0;
    let error = "";
    while (!DONE.has(latest.state)) {
      set(
        {
          phase: /** @type {"queued" | "running"} */ (latest.state),
          siteCount,
          job: latest,
          error,
        },
        mine,
      );
      await wait(Math.min(pollMs * 2 ** missed, MAX_POLL_MS));
      if (mine !== run) return;
      try {
        latest = (await api.getReportJob(latest.jobId)).job;
        missed = 0;
        error = "";
      } catch (err) {
        const code = codeOf(err);
        if (GONE.has(code))
          return set(
            { phase: "failed", siteCount, job: latest, error: code },
            mine,
          );
        missed += 1;
        if (missed >= MAX_MISSED_POLLS) error = code;
      }
    }
    set(ended(latest, siteCount), mine);
  };

  return {
    /** @returns {ReportState | null} */
    get current() {
      return current;
    },
    /** @param {() => void} listener @returns {() => void} unsubscribe */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** @param {string[]} siteIds @param {Record<string, string>} period API period params */
    async start(siteIds, period) {
      const mine = ++run;
      const siteCount = siteIds.length;
      set({ phase: "starting", siteCount, job: null, error: "" }, mine);
      try {
        // A new key per click: the server treats a repeated key as the same report.
        const key = crypto.randomUUID();
        const { job } = await api.createInsightsReport(
          { siteIds, ...period },
          key,
        );
        await follow(job, siteCount, mine);
      } catch (err) {
        set(
          { phase: "failed", siteCount, job: null, error: codeOf(err) },
          mine,
        );
      }
    },
    /** A finished report's link expires before the report does. */
    async refresh() {
      const mine = run;
      const job = current?.job;
      if (current?.phase !== "succeeded" || !job) return;
      const siteCount = current.siteCount;
      // Cleared first, so a second failure is still told to the user.
      set({ ...current, error: "" }, mine);
      const before = current;
      try {
        const fresh = (await api.getReportJob(job.jobId)).job;
        set(ended(fresh, siteCount), mine);
      } catch (err) {
        // Another refresh already got a fresh link; this failure is old news.
        if (current !== before) return;
        const error = codeOf(err);
        if (GONE.has(error))
          return set(
            { phase: "failed", siteCount, job, error: "job_not_found" },
            mine,
          );
        // Anything else may pass, so the fresh-link button stays to try again.
        set({ ...before, error }, mine);
      }
    },
    async cancel() {
      const mine = run;
      const job = current?.job;
      if (!job || DONE.has(job.state)) return;
      const siteCount = current?.siteCount ?? 0;
      try {
        const answered = (await api.cancelReportJob(job.jobId)).job;
        // A newer report replaced this one while the cancel was out.
        if (mine !== run) return;
        run += 1;
        // A job that failed first comes back as it was, with its reason.
        set(ended(answered, siteCount), run);
      } catch {
        // It finished first, or the cancel didn't arrive; the running poll shows which.
      }
    },
  };
}
