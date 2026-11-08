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

/** @typedef {{ record: JobRecord, version: string }} VersionedJob */

/**
 * @typedef {object} JobStore
 * @property {(owner: string, jobId: string, record: JobRecord) => Promise<boolean>} create false if it already exists
 * @property {(owner: string, jobId: string) => Promise<JobRecord | null>} get
 * @property {(owner: string, jobId: string) => Promise<VersionedJob | null>} read
 * @property {(owner: string, jobId: string, record: JobRecord, version?: string) => Promise<string | null>} put the new version, or null if `version` is no longer current
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
  /** @type {Map<string, string>} */
  const versions = new Map();
  let writes = 0;
  /**
   * @param {string} owner
   * @param {string} jobId
   */
  const k = (owner, jobId) => `${owner}/${jobId}`;
  const copy = (/** @type {JobRecord} */ r) => JSON.parse(JSON.stringify(r));
  /**
   * @param {string} key
   * @param {JobRecord} record
   */
  const save = (key, record) => {
    records.set(key, copy(record));
    versions.set(key, String((writes += 1)));
    return /** @type {string} */ (versions.get(key));
  };
  return {
    records,
    results,
    async create(owner, jobId, record) {
      if (records.has(k(owner, jobId))) return false;
      save(k(owner, jobId), record);
      return true;
    },
    async get(owner, jobId) {
      const r = records.get(k(owner, jobId));
      return r ? copy(r) : null;
    },
    async read(owner, jobId) {
      const r = records.get(k(owner, jobId));
      return r
        ? {
            record: copy(r),
            version: /** @type {string} */ (versions.get(k(owner, jobId))),
          }
        : null;
    },
    async put(owner, jobId, record, version) {
      if (version && versions.get(k(owner, jobId)) !== version) return null;
      return save(k(owner, jobId), record);
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

  // Writes only over the version it read, so run, cancel and poll can't undo each other.
  /**
   * @param {string} ownerKey
   * @param {VersionedJob} read
   * @param {(record: JobRecord) => JobRecord | null} change null leaves the record as it is
   * @returns {Promise<VersionedJob & { changed: boolean }>}
   */
  const update = async (ownerKey, read, change) => {
    let current = read;
    for (let tries = 0; tries < 3; tries += 1) {
      const next = change(current.record);
      if (!next) return { ...current, changed: false };
      const version = await store.put(
        ownerKey,
        next.jobId,
        next,
        current.version,
      );
      if (version) return { record: next, version, changed: true };
      const fresh = await store.read(ownerKey, next.jobId);
      if (!fresh) throw requestError("job_not_found", 404);
      current = fresh;
    }
    throw requestError("job_busy", 409);
  };

  /**
   * @param {string} ownerKey
   * @param {VersionedJob} read
   */
  const start = async (ownerKey, read) => {
    try {
      await starter({ ownerKey, jobId: read.record.jobId });
    } catch (err) {
      onError(err, read.record);
      await update(ownerKey, read, (r) =>
        r.state === "queued"
          ? {
              ...r,
              state: "failed",
              error: "job_start_failed",
              updatedAt: iso(),
            }
          : null,
      );
      throw requestError("job_start_failed", 503);
    }
  };

  /** @param {JobRecord} record */
  const isStalled = (record) => {
    const quietMs = now() - Date.parse(record.updatedAt);
    return (
      (record.state === "running" && quietMs > JOB_LIMITS.stallMs) ||
      (record.state === "queued" && quietMs > JOB_LIMITS.queueWaitMs)
    );
  };

  /**
   * @param {string} ownerKey
   * @param {string} jobId
   * @returns {Promise<VersionedJob>}
   */
  const load = async (ownerKey, jobId) => {
    const read = await store.read(ownerKey, jobId);
    if (!read) throw requestError("job_not_found", 404);
    if (now() > Date.parse(read.record.expiresAt))
      throw requestError("job_expired", 410);
    return update(ownerKey, read, (r) =>
      isStalled(r)
        ? { ...r, state: "failed", error: "job_timed_out", updatedAt: iso() }
        : null,
    );
  };

  // A repeat of a known key skips `check`, so a double click doesn't redo the count.
  /**
   * @param {string} ownerKey
   * @param {{ kind: JobRecord["kind"], params: Record<string, any>, idempotencyKey: string, check?: (snap: import("./snapshot.js").Snapshot, params: Record<string, any>) => Record<string, any> | void }} req a returned object from `check` is the params the job stores
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
    const read = await store.read(ownerKey, jobId);
    const existing = read?.record;
    const live = existing && now() <= Date.parse(existing.expiresAt);
    // Another request changed the job since it was read; start again from a fresh read.
    const raced = async () => {
      if (races >= 2) throw requestError("job_busy", 409);
      await wait(50 * (races + 1));
      return create(ownerKey, req, races + 1);
    };
    if (existing && live) {
      if (existing.requestHash !== requestHash)
        throw requestError("idempotency_key_reused", 409);
      if (existing.state !== "failed")
        return { statusCode: 200, job: await view(ownerKey, existing) };
      // A retry reads the newest data and gets a full day to be downloaded.
      const fresh = await snapshots.current();
      const retryParams = check(fresh, existing.params) ?? existing.params;
      const retry = {
        ...existing,
        params: retryParams,
        state: /** @type {JobState} */ ("queued"),
        error: null,
        attempts: existing.attempts + 1,
        snapshotId: fresh.snapshotId,
        snapshotPrefix: fresh.prefix,
        updatedAt: iso(),
        expiresAt: new Date(now() + JOB_LIMITS.ttlMs).toISOString(),
      };
      const version = await store.put(ownerKey, jobId, retry, read.version);
      if (!version) return raced();
      await start(ownerKey, { record: retry, version });
      return { statusCode: 202, job: await view(ownerKey, retry) };
    }
    const snap = await snapshots.current();
    const stored = check(snap, params) ?? params;
    /** @type {JobRecord} */
    const record = {
      jobId,
      kind,
      params: stored,
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
    /** @type {string | null} */
    let version = null;
    if (read) version = await store.put(ownerKey, jobId, record, read.version);
    // The same key won a race; S3 can refuse while that write lands, so try twice more.
    else if (await store.create(ownerKey, jobId, record))
      version = (await store.read(ownerKey, jobId))?.version ?? null;
    if (!version) return raced();
    await start(ownerKey, { record, version });
    return { statusCode: 202, job: await view(ownerKey, record) };
  };

  return {
    create,

    /**
     * @param {string} ownerKey
     * @param {string} jobId
     */
    async get(ownerKey, jobId) {
      return view(ownerKey, (await load(ownerKey, jobId)).record);
    },

    /**
     * @param {string} ownerKey
     * @param {string} jobId
     */
    async cancel(ownerKey, jobId) {
      const { record } = await update(
        ownerKey,
        await load(ownerKey, jobId),
        (r) => {
          if (r.state === "succeeded") throw requestError("job_finished", 409);
          if (r.state === "failed" || r.state === "cancelled") return null;
          return { ...r, state: "cancelled", updatedAt: iso() };
        },
      );
      return view(ownerKey, record);
    },

    /** @param {{ ownerKey: string, jobId: string }} ref */
    async run({ ownerKey, jobId }) {
      const read = await store.read(ownerKey, jobId);
      if (!read) return;
      // SQS delivers at least once; a live run or a cancel ends it here.
      const claim = await update(ownerKey, read, (r) =>
        r.state === "queued" || (r.state === "running" && isStalled(r))
          ? { ...r, state: "running", updatedAt: iso() }
          : null,
      );
      if (!claim.changed) return;
      const { record } = claim;
      /** @type {VersionedJob} */
      let latest = claim;
      try {
        const snap = await snapshots.byPrefix(record.snapshotPrefix);
        const out = await render(record.kind, record.params, snap);
        await store.putResult(ownerKey, jobId, out.body, out.contentType);
        latest = await update(ownerKey, claim, (r) =>
          r.state === "cancelled"
            ? null
            : {
                ...r,
                state: "succeeded",
                error: null,
                updatedAt: iso(),
                dataQuality: out.dataQuality ?? null,
                result: {
                  filename: out.filename,
                  contentType: out.contentType,
                  rows: out.rows,
                  bytes: Buffer.byteLength(out.body),
                },
              },
        );
        // A cancelled request must not leave a file anyone can download.
        if (latest.record.state === "cancelled")
          await store.deleteResult(ownerKey, jobId);
      } catch (err) {
        // A network error's code (ECONNRESET) is ours to log, not the requester's to read.
        const known = isRequestError(err);
        if (!known || err.statusCode >= 500) onError(err, record);
        // A cancel stands; the requester asked for no file.
        await update(ownerKey, latest, (r) =>
          r.state === "cancelled" || r.state === "succeeded"
            ? null
            : {
                ...r,
                state: "failed",
                error: known ? err.code : "job_failed",
                updatedAt: iso(),
              },
        );
      }
    },
  };
}
