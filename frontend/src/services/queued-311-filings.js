import { getTaskDetails } from "./api.js";
import { filing311State } from "../domain/task-actions.js";

/**
 * Checks made while the page is visible: 12 at 5 s, then 36 at 15 s, about
 * 10 minutes. The worker's backoff gives up after about 8 minutes. Time in a
 * hidden tab doesn't count, so a filing that settles while the user is away
 * still updates when they come back.
 */
const FAST_POLLS = 12;
const MAX_POLLS = 48;
/** A stalled request must not hold up later checks. */
const REQUEST_MS = 10_000;

/**
 * Follow background "File 311 ticket" taps until each is filed or fails.
 * Independent and cancellable, like the duplicate watcher: it never blocks
 * the worklist. It skips polls while the page is hidden and checks again as
 * soon as the page is visible.
 * @param {string[]} taskIds tasks whose filing is queued
 * @param {(task: Record<string, unknown>) => void} onSettled called once per
 *   task, with the fresh task, when it is no longer queued
 * @returns {() => void} stop
 */
export function watchQueued311Filings(taskIds, onSettled) {
  const pending = new Set(taskIds.filter(Boolean));
  let stopped = false,
    polls = 0,
    /** @type {AbortController | null} */ round = null,
    /** @type {ReturnType<typeof setTimeout> | undefined} */ timer;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    round?.abort();
    document.removeEventListener("visibilitychange", onVisible);
  };
  /**
   * @param {string} taskId
   * @param {AbortSignal} signal
   * @returns {Promise<boolean>} whether the check got an answer
   */
  const check = async (taskId, signal) => {
    try {
      const { clicked } = await getTaskDetails(taskId, { signal });
      if (stopped) return true;
      if (clicked && filing311State(clicked) !== "queued") {
        pending.delete(taskId);
        onSettled(clicked);
      }
      return true;
    } catch {
      return false;
    }
  };
  const run = async () => {
    clearTimeout(timer);
    if (stopped || round) return;
    let delay = 15000;
    if (!document.hidden) {
      // Most filings land within a minute; then check less often.
      delay = polls++ < FAST_POLLS ? 5000 : 15000;
      const current = (round = new AbortController());
      const deadline = setTimeout(() => current.abort(), REQUEST_MS);
      // All at once, so one slow card doesn't delay the others.
      const answered = await Promise.all(
        [...pending].map((taskId) => check(taskId, current.signal)),
      );
      clearTimeout(deadline);
      round = null;
      if (answered.includes(false)) delay = 15000;
    }
    if (!pending.size || polls >= MAX_POLLS) return stop();
    if (!stopped) timer = setTimeout(run, delay);
  };
  const onVisible = () => {
    if (!document.hidden) void run();
  };
  document.addEventListener("visibilitychange", onVisible);
  timer = setTimeout(run, 3000);
  return stop;
}
