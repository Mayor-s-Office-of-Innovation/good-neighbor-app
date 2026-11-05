// A job is its requester's, reads the snapshot from when it was asked, and lasts a day.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isRequestError, queryHash, requestError } from "./requests.js";

export const JOB_LIMITS = Object.freeze({
  ttlMs: 24 * 3_600_000,
  // Past the Lambda timeout a job has surely died; the queue's visibility timeout must be longer still.
  stallMs: 2 * 60_000,
  // Exports share the query Lambda's few slots, so a busy queue can be slow.
  queueWaitMs: 15 * 60_000,
  downloadSeconds: 300,
});

/** @typedef {"queued" | "running" | "succeeded" | "failed" | "cancelled"} JobState */

/**
 * @typedef {object} JobRecord
 * @property {string} jobId
 * @property {"export" | "report"} kind
 * @property {Record<string, any>} params the checked request, rerun at build time
 * @property {string} requestHash
 * @property {string} snapshotId
 * @property {string} snapshotPrefix
 * @property {JobState} state
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} expiresAt
 * @property {number} attempts
 * @property {string | null} error
 * @property {{ filename: string, contentType: string, rows: number, bytes: number } | null} result
 * @property {Record<string, any> | null} dataQuality
 */

/**
 * @typedef {object} JobStore
 * @property {(owner: string, jobId: string, record: JobRecord) => Promise<boolean>} create false if it already exists
 * @property {(owner: string, jobId: string) => Promise<JobRecord | null>} get
 * @property {(owner: string, jobId: string, record: JobRecord) => Promise<void>} put
 * @property {(owner: string, jobId: string, body: string, contentType: string) => Promise<void>} putResult
 * @property {(owner: string, jobId: string) => Promise<void>} deleteResult
 * @property {(owner: string, jobId: string, filename: string, seconds: number) => Promise<string>} resultUrl
 */

/**
 * @typedef {{ body: string, contentType: string, filename: string, rows: number, dataQuality?: Record<string, any> }} JobOutput
 */

/** @returns {JobStore & { records: Map<string, JobRecord>, results: Map<string, string> }} */
export function memoryJobStore() {
  /** @type {Map<string, JobRecord>} */
  const records = new Map();
  /** @type {Map<string, string>} */
  const results = new Map();
  /**
   * @param {string} owner
   * @param {string} jobId
   */
  const k = (owner, jobId) => `${owner}/${jobId}`;
  const copy = (/** @type {JobRecord} */ r) => JSON.parse(JSON.stringify(r));
  return {
    records,
    results,
    async create(owner, jobId, record) {
      if (records.has(k(owner, jobId))) return false;
      records.set(k(owner, jobId), copy(record));
      return true;
    },
    async get(owner, jobId) {
      const r = records.get(k(owner, jobId));
      return r ? copy(r) : null;
    },
    async put(owner, jobId, record) {
      records.set(k(owner, jobId), copy(record));
    },
    async putResult(owner, jobId, body) {
      results.set(k(owner, jobId), body);
    },
    async deleteResult(owner, jobId) {
      results.delete(k(owner, jobId));
    },
    async resultUrl(owner, jobId, filename) {
      return `memory://${k(owner, jobId)}/${filename}`;
    },
  };
}

/**
 * @param {{
 *   store: JobStore,
 *   snapshots: { current: () => Promise<import("./snapshot.js").Snapshot>, byPrefix: (prefix: string) => Promise<import("./snapshot.js").Snapshot> },
 *   render: (kind: JobRecord["kind"], params: Record<string, any>, snap: import("./snapshot.js").Snapshot) => Promise<JobOutput>,
 *   starter: (ref: { ownerKey: string, jobId: string }) => Promise<void>,
 *   now?: () => number,
 *   onError?: (err: unknown, ref: { jobId: string }) => void,
 *   wait?: (ms: number) => Promise<unknown>,
 * }} deps
 */
export function createJobs({
  store,
  snapshots,
  render,
  starter,
  now = Date.now,
  onError = () => {},
  wait = sleep,
}) {
  const iso = () => new Date(now()).toISOString();

  /**
   * @param {string} ownerKey
   * @param {JobRecord} record
   */
  const view = async (ownerKey, record) => ({
    jobId: record.jobId,
    kind: record.kind,
    state: record.state,
    request: record.params,
    snapshotId: record.snapshotId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    error: record.error,
    result: record.result,
    dataQuality: record.dataQuality,
    downloadUrl:
      record.state === "succeeded" && record.result
        ? await store.resultUrl(
            ownerKey,
            record.jobId,
            record.result.filename,
            JOB_LIMITS.downloadSeconds,
          )
        : null,
  });

  /**
   * @param {string} ownerKey
   * @param {JobRecord} record
   */
  const start = async (ownerKey, record) => {
    try {
      await starter({ ownerKey, jobId: record.jobId });
    } catch (err) {
      onError(err, record);
      await store.put(ownerKey, record.jobId, {
        ...record,
        state: "failed",
        error: "job_start_failed",
        updatedAt: iso(),
      });
      throw requestError("job_start_failed", 503);
    }
  };

  /**
   * @param {string} ownerKey
   * @param {string} jobId
   * @returns {Promise<JobRecord>}
   */
  const load = async (ownerKey, jobId) => {
    const record = await store.get(ownerKey, jobId);
    if (!record) throw requestError("job_not_found", 404);
    if (now() > Date.parse(record.expiresAt))
      throw requestError("job_expired", 410);
    const quietMs = now() - Date.parse(record.updatedAt);
    const stalled =
      (record.state === "running" && quietMs > JOB_LIMITS.stallMs) ||
      (record.state === "queued" && quietMs > JOB_LIMITS.queueWaitMs);
    if (stalled) {
      const failed = {
        ...record,
        state: /** @type {JobState} */ ("failed"),
        error: "job_timed_out",
        updatedAt: iso(),
      };
      await store.put(ownerKey, jobId, failed);
      return failed;
    }
    return record;
  };

  // A repeat of a known key skips `check`, so a double click doesn't redo the count.
  /**
   * @param {string} ownerKey
   * @param {{ kind: JobRecord["kind"], params: Record<string, any>, idempotencyKey: string, check?: (snap: import("./snapshot.js").Snapshot) => void }} req
   * @param {number} [races]
   * @returns {Promise<{ statusCode: number, job: Awaited<ReturnType<typeof view>> }>}
   */
  const create = async (ownerKey, req, races = 0) => {
    const { kind, params, idempotencyKey, check = () => {} } = req;
    const jobId = createHash("sha256")
      .update(`${ownerKey}\n${idempotencyKey}`)
      .digest("hex")
      .slice(0, 32);
    const requestHash = queryHash({ kind, params });
    const existing = await store.get(ownerKey, jobId);
    const live = existing && now() <= Date.parse(existing.expiresAt);
    if (existing && live) {
      if (existing.requestHash !== requestHash)
        throw requestError("idempotency_key_reused", 409);
      if (existing.state !== "failed")
        return { statusCode: 200, job: await view(ownerKey, existing) };
      // A retry reads the newest data and gets a full day to be downloaded.
      const fresh = await snapshots.current();
      check(fresh);
      const retry = {
        ...existing,
        state: /** @type {JobState} */ ("queued"),
        error: null,
        attempts: existing.attempts + 1,
        snapshotId: fresh.snapshotId,
        snapshotPrefix: fresh.prefix,
        updatedAt: iso(),
        expiresAt: new Date(now() + JOB_LIMITS.ttlMs).toISOString(),
      };
      await store.put(ownerKey, jobId, retry);
      await start(ownerKey, retry);
      return { statusCode: 202, job: await view(ownerKey, retry) };
    }
    const snap = await snapshots.current();
    check(snap);
    /** @type {JobRecord} */
    const record = {
      jobId,
      kind,
      params,
      requestHash,
      snapshotId: snap.snapshotId,
      snapshotPrefix: snap.prefix,
      state: "queued",
      createdAt: iso(),
      updatedAt: iso(),
      expiresAt: new Date(now() + JOB_LIMITS.ttlMs).toISOString(),
      attempts: 1,
      error: null,
      result: null,
      dataQuality: null,
    };
    if (existing) await store.put(ownerKey, jobId, record);
    else if (!(await store.create(ownerKey, jobId, record))) {
      // The same key won a race; S3 can refuse while that write lands, so try twice more.
      if (races >= 2) throw requestError("job_busy", 409);
      await wait(50 * (races + 1));
      return create(ownerKey, req, races + 1);
    }
    await start(ownerKey, record);
    return { statusCode: 202, job: await view(ownerKey, record) };
  };

  return {
    create,

    /**
     * @param {string} ownerKey
     * @param {string} jobId
     */
    async get(ownerKey, jobId) {
      return view(ownerKey, await load(ownerKey, jobId));
    },

    /**
     * @param {string} ownerKey
     * @param {string} jobId
     */
    async cancel(ownerKey, jobId) {
      const record = await load(ownerKey, jobId);
      if (record.state === "succeeded") throw requestError("job_finished", 409);
      if (record.state === "failed" || record.state === "cancelled")
        return view(ownerKey, record);
      const cancelled = {
        ...record,
        state: /** @type {JobState} */ ("cancelled"),
        updatedAt: iso(),
      };
      await store.put(ownerKey, jobId, cancelled);
      return view(ownerKey, cancelled);
    },

    /** @param {{ ownerKey: string, jobId: string }} ref */
    async run({ ownerKey, jobId }) {
      const record = await store.get(ownerKey, jobId);
      if (!record) return;
      const abandoned =
        record.state === "running" &&
        now() - Date.parse(record.updatedAt) > JOB_LIMITS.stallMs;
      // SQS delivers at least once; a live run or a cancel ends it here.
      if (record.state !== "queued" && !abandoned) return;
      const running = {
        ...record,
        state: /** @type {JobState} */ ("running"),
        updatedAt: iso(),
      };
      await store.put(ownerKey, jobId, running);
      try {
        const snap = await snapshots.byPrefix(record.snapshotPrefix);
        const out = await render(record.kind, record.params, snap);
        await store.putResult(ownerKey, jobId, out.body, out.contentType);
        // A cancelled request must not leave a file anyone can download.
        if ((await store.get(ownerKey, jobId))?.state === "cancelled") {
          await store.deleteResult(ownerKey, jobId);
          return;
        }
        await store.put(ownerKey, jobId, {
          ...running,
          state: "succeeded",
          updatedAt: iso(),
          dataQuality: out.dataQuality ?? null,
          result: {
            filename: out.filename,
            contentType: out.contentType,
            rows: out.rows,
            bytes: Buffer.byteLength(out.body),
          },
        });
      } catch (err) {
        // A network error's code (ECONNRESET) is ours to log, not the requester's to read.
        const known = isRequestError(err);
        if (!known || err.statusCode >= 500) onError(err, record);
        // A cancel stands; the requester asked for no file.
        if ((await store.get(ownerKey, jobId))?.state === "cancelled") return;
        await store.put(ownerKey, jobId, {
          ...running,
          state: "failed",
          error: known ? err.code : "job_failed",
          updatedAt: iso(),
        });
      }
    },
  };
}
