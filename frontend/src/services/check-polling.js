import { getSite } from "../db.js";

/** @typedef {{check: any, artifacts: any[], analyses: any[]}} CheckSnapshot */
/** @typedef {{inspect: (snapshot: CheckSnapshot) => any, resolve: (value: any) => void, reject: (error: unknown) => void, intervalMs: number}} Subscriber */
/** @typedef {{checkId: string, controller: AbortController, subscribers: Set<Subscriber>, timer?: ReturnType<typeof setTimeout>}} Poll */
/** @type {Map<string, Poll>} */
const polls = new Map();
/** @type {Map<string, Set<{ canceled: boolean }>>} */
const joining = new Map();

/** Cancel consumers and discard any late response when the check is abandoned.
 * @param {string} checkId
 */
export function cancelCheckPolling(checkId) {
  for (const pending of joining.get(checkId) || []) pending.canceled = true;
  for (const [key, poll] of polls) {
    if (poll.checkId !== checkId) continue;
    polls.delete(key);
    clearTimeout(poll.timer);
    poll.controller.abort();
    for (const subscriber of poll.subscribers) {
      subscriber.reject(
        new DOMException("Check polling canceled", "AbortError"),
      );
    }
    poll.subscribers.clear();
  }
}

/** Share reads, but let each consumer independently finish or throw its timeout.
 * No settled-result cache: a later retry starts a fresh read.
 * @template T
 * @param {string} checkId
 * @param {(checkId: string, options: {signal: AbortSignal, originSiteId: string}) => Promise<CheckSnapshot>} read
 * @param {(snapshot: CheckSnapshot) => T | undefined} inspect
 * @param {{intervalMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function pollCheck(
  checkId,
  read,
  inspect,
  { intervalMs = 2000 } = {},
) {
  const pending = { canceled: false };
  const joins = joining.get(checkId) || new Set();
  joining.set(checkId, joins);
  joins.add(pending);
  const site = await getSite().catch(() => null);
  joins.delete(pending);
  if (!joins.size) joining.delete(checkId);
  if (pending.canceled) {
    throw new DOMException("Check polling canceled", "AbortError");
  }
  const originSiteId = site?.siteId || "";
  const key = JSON.stringify([originSiteId, checkId]);
  let poll = polls.get(key);
  const fresh = !poll;
  if (!poll) {
    poll = {
      checkId,
      controller: new AbortController(),
      subscribers: new Set(),
    };
    polls.set(key, poll);
  }
  const active = poll;
  const promise = new Promise((resolve, reject) => {
    active.subscribers.add({ inspect, resolve, reject, intervalMs });
  });
  const run = async () => {
    try {
      const snapshot = await read(checkId, {
        signal: active.controller.signal,
        originSiteId,
      });
      if (polls.get(key) !== active) return;
      if (originSiteId) {
        const currentSite = await getSite();
        if (currentSite?.siteId !== originSiteId) {
          throw new DOMException(
            "Site changed during check polling",
            "AbortError",
          );
        }
        if (polls.get(key) !== active) return;
      }
      for (const subscriber of active.subscribers) {
        try {
          const result = subscriber.inspect(snapshot);
          if (result === undefined) continue;
          active.subscribers.delete(subscriber);
          subscriber.resolve(result);
        } catch (error) {
          active.subscribers.delete(subscriber);
          subscriber.reject(error);
        }
      }
    } catch (error) {
      if (polls.get(key) !== active) return;
      for (const subscriber of active.subscribers) subscriber.reject(error);
      active.subscribers.clear();
    }
    if (polls.get(key) !== active) return;
    if (!active.subscribers.size) {
      polls.delete(key);
      return;
    }
    active.timer = setTimeout(
      run,
      Math.min(...[...active.subscribers].map((s) => s.intervalMs)),
    );
  };
  if (fresh) void run();
  return promise;
}
