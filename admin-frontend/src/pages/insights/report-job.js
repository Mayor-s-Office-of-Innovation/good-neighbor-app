// Lives outside Overview, so leaving it and coming back still shows how the
// report is going.

/** @typedef {{ jobId: string, state: string, error: string | null, expiresAt: string, downloadUrl: string | null, downloadSeconds?: number | null, result: { filename: string, rows?: number } | null }} Job */
/** @typedef {{ phase: "starting" | "queued" | "running" | "succeeded" | "failed" | "cancelled", count: number, job: Job | null, error: string, linkUntil?: number }} ReportState count is how many items the job covers */
/**
 * @typedef {{
 *   createInsightsReport: (body: Record<string, unknown>, key: string) => Promise<{ job: Job }>,
 *   getReportJob: (id: string) => Promise<{ job: Job }>,
 * }} ReportApi
 */

const DONE = new Set(["succeeded", "failed", "cancelled"]);
// The server no longer has the report, so asking again can't help.
const GONE = new Set(["job_not_found", "job_expired"]);
// After this many failed reads the button says it can't check; the job runs on, so polling does too.
const MAX_MISSED_POLLS = 3;
// Slower polls while reads fail, so an outage isn't hit every 2 seconds.
const MAX_POLL_MS = 30_000;
// The server fails a job queued 15 minutes or quiet 2 while running, so no answer is coming after this.
export const MAX_FOLLOW_MS = 20 * 60_000;
// For a server that doesn't say how long its download link lasts; it signs them for 5 minutes.
export const LINK_MS = 4 * 60 * 1000;
// A fresh link is fetched a minute early, so a click near the end still downloads.
const LINK_MARGIN_MS = 60_000;

/** @param {ReportState | null} state @param {number} now @returns {number} ms until the link needs fetching again */
export const linkLeft = (state, now) =>
  state?.phase === "succeeded" && state.linkUntil !== undefined
    ? Math.max(0, state.linkUntil - now)
    : 0;

/** getRandomValues works on plain-http origins too, such as a phone test over the LAN; randomUUID doesn't. */
export function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} err */
const statusOf = (err) => Number(/** @type {any} */ (err)?.status);

/** A 4xx refuses the ask itself, so asking again can't help; 408 and 429 can pass later. @param {unknown} err */
const refused = (err) => {
  const status = statusOf(err);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
};

/** A timeout's message is a sentence, so its code goes first. @param {unknown} err */
const codeOf = (err) => {
  const code = /** @type {any} */ (err)?.code;
  if (typeof code === "string" && code) return code;
  return err instanceof Error && err.message ? err.message : "job_failed";
};

/** Waits for the tab to be shown, so a hidden tab doesn't poll. */
const whenVisible = () =>
  !document.hidden
    ? Promise.resolve()
    : new Promise((resolve) => {
        const shown = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", shown);
          resolve(undefined);
        };
        document.addEventListener("visibilitychange", shown);
      });

/** @param {ReportState | null} a @param {ReportState} b */
const same = (a, b) =>
  !!a &&
  a.phase === b.phase &&
  a.count === b.count &&
  a.error === b.error &&
  a.job?.jobId === b.job?.jobId &&
  a.job?.state === b.job?.state &&
  a.job?.downloadUrl === b.job?.downloadUrl &&
  a.linkUntil === b.linkUntil;

/**
 * @param {{ api: ReportApi, create?: ReportApi["createInsightsReport"], wait?: (ms: number) => Promise<void>, visible?: () => Promise<unknown>, pollMs?: number, now?: () => number }} deps
 * create starts the job; visible resolves once the tab is shown
 */
export function createReportJobs({
  api,
  create = api.createInsightsReport,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  visible = whenVisible,
  pollMs = 2000,
  now = Date.now,
}) {
  /** @type {ReportState | null} */
  let current = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  // Each start gets its own run, so an old poll can't overwrite a new report.
  let run = 0;
  // Kept for Try again, which repeats the ask that failed.
  /** @type {{ body: Record<string, unknown>, count: number, key: string } | null} */
  let last = null;

  /** @param {ReportState} next @param {number} mine */
  const set = (next, mine) => {
    // A poll with no news mustn't redraw the bar or repeat its announcement.
    if (mine !== run || same(current, next)) return;
    current = next;
    tell();
  };

  // A page's drawing bug mustn't fail the report or skip the other pages.
  const tell = () => {
    for (const listener of listeners)
      try {
        listener();
      } catch (err) {
        console.error("report job listener failed", err);
      }
  };

  /** @param {Job} job */
  const linkUntil = (job) => {
    if (!job.downloadUrl) return undefined;
    // A length, not a time, so a wrong clock on this computer can't spoil it.
    const life =
      typeof job.downloadSeconds === "number"
        ? job.downloadSeconds * 1000 - LINK_MARGIN_MS
        : LINK_MS;
    return now() + life;
  };

  /** @param {Job} job @param {number} count */
  const ended = (job, count) =>
    /** @type {ReportState} */ ({
      phase: job.state,
      count,
      job,
      error: job.error || "",
      linkUntil: linkUntil(job),
    });

  /** @param {Job} job @param {number} count @param {number} mine */
  const follow = async (job, count, mine) => {
    const giveUpAt = now() + MAX_FOLLOW_MS;
    let latest = job;
    let missed = 0;
    let error = "";
    while (!DONE.has(latest.state)) {
      set(
        {
          phase: /** @type {"queued" | "running"} */ (latest.state),
          count,
          job: latest,
          error,
        },
        mine,
      );
      await wait(Math.min(pollMs * 2 ** missed, MAX_POLL_MS));
      await visible();
      if (mine !== run) return;
      try {
        latest = (await api.getReportJob(latest.jobId)).job;
        missed = 0;
        error = "";
      } catch (err) {
        const code = codeOf(err);
        if (GONE.has(code) || refused(err))
          return set(
            { phase: "failed", count, job: latest, error: code },
            mine,
          );
        missed += 1;
        if (missed >= MAX_MISSED_POLLS) error = code;
      }
      if (!DONE.has(latest.state) && now() > giveUpAt)
        return set(
          { phase: "failed", count, job: latest, error: "job_timed_out" },
          mine,
        );
    }
    set(ended(latest, count), mine);
  };

  /** @param {Record<string, unknown>} body @param {number} count @param {string} key */
  const begin = async (body, count, key) => {
    const mine = ++run;
    last = { body, count, key };
    set({ phase: "starting", count, job: null, error: "" }, mine);
    try {
      const { job } = await create(body, key);
      await follow(job, count, mine);
    } catch (err) {
      set({ phase: "failed", count, job: null, error: codeOf(err) }, mine);
    }
  };

  /** A new key per ask: the server treats a repeated key as the same job. @param {Record<string, unknown>} body @param {number} count */
  const startWith = (body, count) => begin(body, count, newKey());

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
    start: (siteIds, period) =>
      startWith({ siteIds, ...period }, siteIds.length),
    startWith,
    /** The same key, so a job the server made before a lost reply is reused, not made twice. */
    retry() {
      if (!last) return Promise.resolve();
      // The server answers a cancelled job's key with that job, so only a new key starts it again.
      const key = current?.phase === "cancelled" ? newKey() : last.key;
      return begin(last.body, last.count, key);
    },
    /** The user has seen how the job ended, so a return to the page doesn't show it again. */
    dismiss() {
      run += 1;
      if (!current) return;
      current = null;
      tell();
    },
    /** Whether the ready report's link can still be used. */
    linkFresh() {
      return !!current?.job?.downloadUrl && linkLeft(current, now()) > 0;
    },
    /** A finished report's link expires before the report does. */
    async refresh() {
      const mine = run;
      const job = current?.job;
      if (current?.phase !== "succeeded" || !job) return;
      const count = current.count;
      // Cleared first, so a second failure is still told to the user.
      set({ ...current, error: "" }, mine);
      const before = current;
      try {
        const fresh = (await api.getReportJob(job.jobId)).job;
        const next = ended(fresh, count);
        // Without a link the Download button would do nothing, so say so.
        if (next.phase === "succeeded" && !fresh.downloadUrl)
          next.error = "link_missing";
        set(next, mine);
      } catch (err) {
        // Another refresh already got a fresh link; this failure is old news.
        if (current !== before) return;
        const error = codeOf(err);
        if (GONE.has(error))
          return set(
            { phase: "failed", count, job, error: "job_not_found" },
            mine,
          );
        // Anything else may pass, so the fresh-link button stays to try again.
        set({ ...before, error }, mine);
      }
    },
  };
}
