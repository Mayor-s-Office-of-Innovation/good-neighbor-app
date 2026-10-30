import { onDuplicateInvalidation } from "./duplicate-invalidation.js";
import { duplicateUiEnabled, onDuplicateUiChange } from "./feature-flags.js";
import { getDuplicateLinks } from "./api.js";
import { getSite } from "../db.js";

/** @typedef {{ids: string[], onChange: (links: Map<string, Record<string, any>>) => void, expired: boolean, ready: boolean, siteCheckDue: number, previous: string, expiry?: ReturnType<typeof setTimeout>}} Subscriber */
/** @typedef {{due: number, polls: number, row?: Record<string, any>}} Task */
/** @type {Set<Subscriber>} */
const subscribers = new Set();
/** @type {Map<string, Task>} */
const tasks = new Map();
let timer;
let running = false;
/** @type {AbortController | undefined} */
let activeController;
let generation = 0;
let cooldownUntil = 0;
let siteId;

function stop(subscriber) {
  if (!subscribers.delete(subscriber)) return;
  clearTimeout(subscriber.expiry);
  if (![...subscribers].some((s) => !s.expired)) {
    generation++;
    clearTimeout(timer);
    activeController?.abort();
    running = false;
  }
  schedule();
}

function clear() {
  cooldownUntil = 0;
  tasks.clear();
  siteId = undefined;
  for (const subscriber of [...subscribers]) {
    stop(subscriber);
    subscriber.onChange(new Map());
  }
}

function publish(subscriber) {
  if (!subscribers.has(subscriber) || !subscriber.ready) return;
  // Callers replace their entire map: publish only once every requested ID
  // has a result, including an explicit missing row from a successful batch.
  if (!subscriber.ids.every((id) => Object.hasOwn(tasks.get(id) || {}, "row")))
    return;
  const rows = subscriber.ids.flatMap((id) => {
    const row = tasks.get(id)?.row;
    return row
      ? [
          subscriber.expired && row.state === "pending"
            ? { ...row, state: "unavailable" }
            : row,
        ]
      : [];
  });
  const key = JSON.stringify(rows);
  if (key !== subscriber.previous) {
    subscriber.previous = key;
    subscriber.onChange(new Map(rows.map((row) => [row.taskId, row])));
  }
}

function schedule() {
  if (running || !subscribers.size) return;
  clearTimeout(timer);
  if (!duplicateUiEnabled()) return;
  const next = Math.min(
    ...activeTasks().map(([, task]) => task.due),
    ...[...subscribers]
      .filter((s) => !s.expired && !s.ready)
      .map((s) => s.siteCheckDue),
  );
  if (!Number.isFinite(next)) return;
  timer = setTimeout(
    run,
    Math.min(
      2147483647,
      Math.max(0, Math.max(next, cooldownUntil) - Date.now()),
    ),
  );
}

/**
 * Only active retry budgets can schedule work; settled rows have no due time.
 * @returns {[string, Task][]}
 */
function activeTasks() {
  const wanted = new Set(
    [...subscribers].filter((s) => !s.expired && s.ready).flatMap((s) => s.ids),
  );
  return [...tasks].filter(([id]) => wanted.has(id));
}

/** @param {Subscriber} subscriber */
function renew(subscriber) {
  clearTimeout(subscriber.expiry);
  subscriber.expired = false;
  subscriber.expiry = setTimeout(
    () => {
      subscriber.expired = true;
      publish(subscriber);
      if (![...subscribers].some((s) => !s.expired)) {
        generation++;
        activeController?.abort();
        running = false;
      }
      schedule();
    },
    15 * 60 * 1000,
  );
}

async function run() {
  const activeGeneration = generation;
  running = true;
  try {
    if (Date.now() < cooldownUntil) return;
    const site = await bounded(() => getSite());
    if (generation !== activeGeneration) return;
    const currentSiteId = site?.siteId || "";
    if (siteId !== undefined && siteId !== currentSiteId) {
      tasks.clear();
      for (const subscriber of subscribers) {
        subscriber.previous = "";
        for (const id of subscriber.ids)
          tasks.set(id, { due: Date.now(), polls: 0 });
      }
    }
    siteId = currentSiteId;
    // Verify the binding and publish cached rows through this single bounded
    // path. A separate initialization read could race and abandon a new watch.
    for (const subscriber of subscribers) {
      subscriber.ready = true;
      publish(subscriber);
    }
    const due = activeTasks().filter(([, task]) => task.due <= Date.now());
    if (document.hidden) {
      for (const [, task] of due) task.due = Date.now() + 2000;
      return;
    }
    for (let i = 0; i < due.length; i += 50) {
      const wanted = new Set(activeTasks().map(([id]) => id));
      const batch = due
        .slice(i, i + 50)
        .filter(([id, task]) => wanted.has(id) && tasks.get(id) === task);
      if (!batch.length) continue;
      try {
        const { result, currentSite } = await bounded(async (signal) => {
          const result = await getDuplicateLinks(
            batch.map(([id]) => id),
            { originSiteId: siteId, signal },
          );
          const currentSite = await getSite();
          return { result, currentSite };
        });
        if (generation !== activeGeneration) return;
        if ((currentSite?.siteId || "") !== siteId || !duplicateUiEnabled()) {
          clear();
          return;
        }
        for (const [id, task] of batch) {
          if (tasks.get(id) !== task) continue;
          // Disabled rows are settled, but the subscription stays alive for
          // invalidation. Later batches may still contain persisted links.
          task.row = result.enabled
            ? result.issues.find((row) => row.taskId === id)
            : undefined;
          const delay = task.polls++ < 15 ? 2000 : 5000;
          task.due =
            task.row?.state === "pending" ? Date.now() + delay : Infinity;
        }
        for (const subscriber of [...subscribers]) publish(subscriber);
      } catch (error) {
        if (generation !== activeGeneration) return;
        if (error?.status === 429) {
          const delay =
            Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0
              ? error.retryAfterMs
              : 300000;
          // Positive jitter avoids another synchronized burst. Never shorten the
          // server's advice, and pause remaining batches and new subscriptions.
          cooldownUntil =
            Date.now() + Math.max(1000, delay) + Math.random() * 1000;
          for (const task of tasks.values())
            task.due = Math.max(task.due, cooldownUntil);
          break;
        }
        for (const [id, task] of batch)
          if (tasks.get(id) === task) task.due = Date.now() + 15000;
      }
    }
  } catch {
    if (generation !== activeGeneration) return;
    for (const [, task] of activeTasks())
      if (Number.isFinite(task.due)) task.due = Date.now() + 15000;
    for (const subscriber of subscribers)
      if (!subscriber.ready) subscriber.siteCheckDue = Date.now() + 15000;
  } finally {
    if (generation === activeGeneration) {
      running = false;
      schedule();
    }
  }
}

/**
 * Share site-bound batches and session cache. Retry budgets expire independently;
 * subscriptions stay mounted for explicit invalidation. No age-based refresh.
 * @param {string[]} taskIds
 * @param {(links: Map<string, Record<string, any>>) => void} onChange
 */
export function watchDuplicateIssues(taskIds, onChange) {
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (!ids.length) return () => {};
  /** @type {Subscriber} */
  const subscriber = {
    ids,
    onChange,
    expired: false,
    ready: false,
    siteCheckDue: Date.now(),
    previous: "",
  };
  subscribers.add(subscriber);
  if (duplicateUiEnabled()) renew(subscriber);
  for (const id of ids)
    if (!tasks.has(id)) tasks.set(id, { due: Date.now(), polls: 0 });
  // The scheduled run verifies the site before publishing, asynchronously so
  // callers can install their stop handle. Cache hits do not make API calls.
  schedule();
  return () => stop(subscriber);
}

/**
 * Invalidate the site's cache, including dependents and currently unmounted tasks.
 * @param {string} [originSiteId]
 */
function invalidateDuplicateIssues(originSiteId) {
  if (originSiteId && siteId !== undefined && originSiteId !== siteId) return;
  generation++;
  clearTimeout(timer);
  activeController?.abort();
  running = false;
  for (const id of tasks.keys()) {
    // Replacing the record also invalidates batches holding the old object.
    tasks.set(id, {
      due: Date.now(),
      polls: 0,
      row: { taskId: id, state: "pending" },
    });
  }
  for (const subscriber of [...subscribers]) {
    if (duplicateUiEnabled()) {
      renew(subscriber);
      publish(subscriber);
    }
  }
  schedule();
}

// Keep cache invalidation alive between mounts. Disabling the UI clears cached
// evidence but retains subscriptions so late site settings can start them.
onDuplicateInvalidation(invalidateDuplicateIssues);
onDuplicateUiChange(() => {
  cooldownUntil = 0;
  generation++;
  clearTimeout(timer);
  activeController?.abort();
  running = false;
  tasks.clear();
  siteId = undefined;
  for (const subscriber of subscribers) {
    clearTimeout(subscriber.expiry);
    subscriber.previous = "";
    subscriber.ready = false;
    subscriber.siteCheckDue = Date.now();
    subscriber.onChange(new Map());
    for (const id of subscriber.ids)
      tasks.set(id, { due: Date.now(), polls: 0 });
    if (duplicateUiEnabled()) renew(subscriber);
  }
  schedule();
});

/** Bound both network and local-storage waits so one batch cannot stall the service.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function bounded(work) {
  const controller = new AbortController();
  activeController = controller;
  let timeout;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise(
        /** @param {(value: T) => void} _ */ (_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
          timeout = setTimeout(() => {
            controller.abort(
              new DOMException("Duplicate polling timed out", "TimeoutError"),
            );
          }, 10000);
        },
      ),
    ]);
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) activeController = undefined;
  }
}
