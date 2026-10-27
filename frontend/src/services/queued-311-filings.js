import { getTaskDetails } from "./api.js";
import { filing311State } from "../domain/task-actions.js";

/** The worker's backoff gives up after about 8 minutes; leave some slack. */
const WATCH_MS = 10 * 60 * 1000;

/**
 * Follow background "File 311 ticket" taps until each is filed
 * or fails. Independent and cancellable, like the duplicate watcher: it never
 * blocks the worklist, and it skips polls while the page is hidden.
 * @param {string[]} taskIds tasks whose filing is queued
 * @param {(task: Record<string, unknown>) => void} onSettled called once per
 *   task, with the fresh task, when it is no longer queued
 * @returns {() => void} stop
 */
export function watchQueued311Filings(taskIds, onSettled) {
  const pending = new Set(taskIds.filter(Boolean));
  const started = Date.now();
  let stopped = false,
    polls = 0,
    /** @type {ReturnType<typeof setTimeout> | undefined} */ timer;
  const run = async () => {
    if (stopped || !pending.size || Date.now() - started > WATCH_MS) return;
    // Most filings land within a minute; then check less often.
    let delay = polls++ < 12 ? 5000 : 15000;
    if (!document.hidden) {
      for (const taskId of [...pending]) {
        try {
          const { clicked } = await getTaskDetails(taskId);
          if (stopped) return;
          if (clicked && filing311State(clicked) !== "queued") {
            pending.delete(taskId);
            onSettled(clicked);
          }
        } catch {
          delay = 15000;
        }
      }
    }
    if (!stopped) timer = setTimeout(run, delay);
  };
  timer = setTimeout(run, 3000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
