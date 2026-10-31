import { getHealthState } from "./backend-health.js";

export const AUTO_RETRIES = 3;
export const removingEvidence = new Set();

export function connectionAvailable() {
  return (
    globalThis.navigator?.onLine !== false && getHealthState() === "healthy"
  );
}

/** @param {any} item */
export function canManuallyRetry(item) {
  if (item?.deletionPending) return false;
  return (
    connectionAvailable() &&
    !removingEvidence.has(item?.id) &&
    item?.analysis?.status === "failed" &&
    item.analysis?.recovery?.state === "manual"
  );
}

/** @param {any} previous @param {string} stage @param {any} error */
export function failedRecovery(previous, stage, error) {
  const attempts = previous?.stage === stage ? previous.attempts || 0 : 0;
  const transient =
    !error?.status ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500;
  if (!transient) return { stage, attempts, state: "blocked" };
  if (attempts >= AUTO_RETRIES) return { stage, attempts, state: "manual" };
  return {
    stage,
    attempts: attempts + 1,
    state: "scheduled",
    nextAttemptAt:
      Date.now() +
      Math.max(
        error?.retryAfterMs || 0,
        2000 * 2 ** attempts * (0.8 + Math.random() * 0.4),
      ),
  };
}

const transfers = [];
let running = 0;
export const UPLOAD_CONCURRENCY = 2;

/** FIFO in this tab, origin-wide slots where Web Locks are supported.
 * Analysis observation happens after this promise releases its slot.
 * @template T @param {() => Promise<T>} work @returns {Promise<T>}
 */
export function withUploadSlot(work) {
  return new Promise((resolve, reject) => {
    transfers.push({ work, resolve, reject });
    drain();
  });
}

function drain() {
  while (running < UPLOAD_CONCURRENCY && transfers.length) {
    const job = transfers.shift();
    running++;
    void claimSlot(job.work)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        drain();
      });
  }
}

/** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
async function claimSlot(work) {
  if (!connectionAvailable())
    throw Object.assign(new Error("Connection unavailable"), { status: 0 });
  const locks = globalThis.navigator?.locks;
  if (!locks) return work();
  for (;;) {
    for (let slot = 0; slot < UPLOAD_CONCURRENCY; slot++) {
      const result = await locks.request(
        `check-upload:${slot}`,
        { ifAvailable: true },
        async (lock) => (lock ? { value: await work() } : null),
      );
      if (result) return result.value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!connectionAvailable())
      throw Object.assign(new Error("Connection unavailable"), { status: 0 });
  }
}
