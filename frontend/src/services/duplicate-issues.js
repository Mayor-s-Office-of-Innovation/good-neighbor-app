import { onDuplicateInvalidation } from "./duplicate-invalidation.js";
import { duplicateUiEnabled, onDuplicateUiChange } from "./feature-flags.js";
import { getDuplicateLinks } from "./api.js";
import { getSite } from "../db.js";

/** @typedef {{ids: string[], onChange: (links: Map<string, Record<string, any>>) => void, started: number, previous: string, expiry?: ReturnType<typeof setTimeout>}} Subscriber */
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
let unsubscribe;
let unsubscribeInvalidation;

function stop(subscriber) {
  if (!subscribers.delete(subscriber)) return;
  clearTimeout(subscriber.expiry);
  const wanted = new Set([...subscribers].flatMap((s) => s.ids));
  for (const id of tasks.keys()) if (!wanted.has(id)) tasks.delete(id);
  if (!subscribers.size) {
    generation++;
    clearTimeout(timer);
    activeController?.abort();
    running = false;
    siteId = undefined;
    cooldownUntil = 0;
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeInvalidation?.();
    unsubscribeInvalidation = undefined;
  }
}

function clear() {
  for (const subscriber of [...subscribers]) {
    stop(subscriber);
    subscriber.onChange(new Map());
  }
}

function publish(subscriber, expired = false) {
  if (!subscribers.has(subscriber)) return;
  // Callers replace their entire map: publish only once every requested ID
  // has a result, including an explicit missing row from a successful batch.
  if (!subscriber.ids.every((id) => Object.hasOwn(tasks.get(id) || {}, "row")))
    return;
  const rows = subscriber.ids.flatMap((id) => {
    const row = tasks.get(id)?.row;
    return row
      ? [
          expired && row.state === "pending"
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
  const next = Math.min(...[...tasks.values()].map((task) => task.due));
  timer = setTimeout(
    run,
    Math.min(
      2147483647,
      Math.max(0, Math.max(next, cooldownUntil) - Date.now()),
    ),
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
      clear();
      return;
    }
    siteId = currentSiteId;
    const due = [...tasks].filter(([, task]) => task.due <= Date.now());
    if (document.hidden) {
      for (const [, task] of due) task.due = Date.now() + 2000;
      return;
    }
    for (let i = 0; i < due.length; i += 50) {
      const batch = due
        .slice(i, i + 50)
        .filter(([id, task]) => tasks.get(id) === task);
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
        if (!result.enabled) {
          clear();
          return;
        }
        for (const [id, task] of batch) {
          if (tasks.get(id) !== task) continue;
          task.row = result.issues.find((row) => row.taskId === id);
          const delay = task.polls++ < 15 ? 2000 : 5000;
          task.due =
            Date.now() + (task.row?.state === "pending" ? delay : 30000);
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
        for (const [, task] of batch) task.due = Date.now() + 15000;
      }
    }
  } catch {
    if (generation !== activeGeneration) return;
    for (const task of tasks.values()) task.due = Date.now() + 15000;
  } finally {
    if (generation === activeGeneration) {
      running = false;
      schedule();
    }
  }
}

/**
 * Share site-bound batches across home and photo cards; subscriptions expire independently.
 * @param {string[]} taskIds
 * @param {(links: Map<string, Record<string, any>>) => void} onChange
 */
export function watchDuplicateIssues(taskIds, onChange) {
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (!duplicateUiEnabled() || !ids.length) return () => {};
  /** @type {Subscriber} */
  const subscriber = { ids, onChange, started: Date.now(), previous: "" };
  subscribers.add(subscriber);
  subscriber.expiry = setTimeout(
    () => {
      try {
        publish(subscriber, true);
      } finally {
        stop(subscriber);
      }
    },
    15 * 60 * 1000,
  );
  for (const id of ids)
    if (!tasks.has(id)) tasks.set(id, { due: Date.now(), polls: 0 });
  if (!unsubscribe)
    unsubscribe = onDuplicateUiChange(() => {
      if (!duplicateUiEnabled()) clear();
    });
  if (!unsubscribeInvalidation)
    unsubscribeInvalidation = onDuplicateInvalidation(
      invalidateDuplicateIssues,
    );
  // Publish cached rows asynchronously so callers can install their stop handle.
  const activeGeneration = generation;
  void getSite()
    .then((site) => {
      if (generation !== activeGeneration || !subscribers.has(subscriber))
        return;
      if (siteId !== undefined && (site?.siteId || "") !== siteId) {
        clear();
        return;
      }
      if (ids.some((id) => tasks.get(id)?.row)) publish(subscriber);
    })
    .catch(() => {});
  schedule();
  return () => stop(subscriber);
}

/** Discard cached matches and pre-mutation responses after a successful separation. */
function invalidateDuplicateIssues() {
  for (const id of tasks.keys()) {
    // Replacing the record also invalidates batches holding the old object.
    tasks.set(id, {
      due: Date.now(),
      polls: 0,
      row: { taskId: id, state: "pending" },
    });
  }
  for (const subscriber of [...subscribers]) publish(subscriber);
  schedule();
}

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
