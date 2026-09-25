// Ad-hoc and catalog DuckDB queries over the Parquet lake (ADR 0013, ad-hoc
// leg). Serves the admin analytics endpoints; never touches DynamoDB.
//
// Design notes:
// - One DuckDB instance + connection per Lambda sandbox, created lazily. The
//   views come from lake-views.js (shared with the report Lambda) and DuckDB
//   re-plans them per query, so new Parquet files show up without a rebuild.
//   Entities that had no files at startup keep an empty stand-in view; those
//   are re-probed on a short interval and swapped for real views once data
//   lands.
// - The engine is locked down after setup (lake-views lockdown): no local
//   filesystem, no configuration changes. Combined with IAM that grants the
//   role read access to the lake only, that is the security boundary — not
//   SQL parsing.
// - User SQL is run as `SELECT * FROM (<sql>)`, which makes DDL, PRAGMA,
//   INSTALL, COPY and multi-statement input parser errors while leaving
//   SELECTs and CTEs intact. Catalog queries bind parameters through DuckDB
//   prepared statements, never string interpolation.

import { S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  ENTITIES,
  createViews,
  lockdown,
  stripTrailingSemicolon,
} from "./lake-views.js";

export { ENTITIES };

// The analytics lake is always real AWS S3 — never the local MinIO harness
// bucket. The local harness exports MinIO-flavored AWS_* env creds plus an S3
// endpoint override for the app services; the analytics leg must ignore both.
// Pin the real regional endpoint, and when LAKE_AWS_PROFILE is set resolve
// credentials through that profile (the SDK chain then skips the env stubs).
// The deployed Lambda sets no profile: the S3 client and DuckDB's own
// credential chain both resolve the execution role's container credentials.
const LAKE_REGION = process.env.LAKE_REGION || "us-west-2";
const LAKE_PROFILE = process.env.LAKE_AWS_PROFILE || "";
const lakeCredentials = LAKE_PROFILE
  ? defaultProvider({ profile: LAKE_PROFILE })
  : undefined;
const s3 = new S3Client({
  region: LAKE_REGION,
  endpoint: `https://s3.${LAKE_REGION}.amazonaws.com`,
  ...(lakeCredentials
    ? { credentialDefaultProvider: () => lakeCredentials }
    : {}),
});

/**
 * A query failure classified for the HTTP layer. `user` errors are the
 * caller's SQL (parse, bind, catalog, conversion) and safe to echo back;
 * `engine` errors are ours (S3, extension, IO) and are logged, not echoed.
 */
export class QueryError extends Error {
  /**
   * @param {"user" | "engine"} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = "QueryError";
    this.kind = kind;
  }
}

const USER_ERROR =
  /^(Parser|Binder|Catalog|Conversion|Invalid Input|Out of Range|Not implemented|Constraint|Syntax) Error/i;

// ---- Warm-sandbox connection ------------------------------------------------

/**
 * @typedef {{
 *   conn: any,
 *   bucket: string,
 *   empty: Set<string>,
 *   refreshedAt: number,
 *   asOf: string | null,
 * }} WarmState
 */

/** @type {WarmState | null} */
let warm = null;

// How often a warm sandbox re-probes empty entities and refreshes the
// freshness stamp. Exports land every 6 hours, so this is generous.
const REFRESH_MS = 5 * 60 * 1000;

/**
 * Get (or create) the warm connection with views current for `bucket`.
 * @param {string} bucket
 * @returns {Promise<WarmState>}
 */
async function getWarm(bucket) {
  if (!warm || warm.bucket !== bucket) {
    if (warm) {
      try {
        warm.conn.closeSync();
      } catch {
        // a broken connection is fine to abandon
      }
      warm = null;
    }
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    const { empty } = await createViews(conn, bucket, {
      s3,
      credentials: lakeCredentials,
      region: LAKE_REGION,
    });
    await lockdown(conn);
    warm = {
      conn,
      bucket,
      empty: new Set(empty),
      refreshedAt: Date.now(),
      asOf: await readAsOf(conn),
    };
    return warm;
  }
  if (Date.now() - warm.refreshedAt > REFRESH_MS) await refreshWarm(warm);
  return warm;
}

/**
 * Re-probe entities still on an empty stand-in view and refresh the
 * freshness stamp. Real views need no rebuild (DuckDB re-globs per query).
 * @param {WarmState} state
 */
async function refreshWarm(state) {
  if (state.empty.size > 0) {
    const { empty } = await createViews(state.conn, state.bucket, {
      s3,
      install: false,
      entities: [...state.empty],
    });
    state.empty = new Set(empty);
  }
  state.asOf = await readAsOf(state.conn);
  state.refreshedAt = Date.now();
}

/**
 * Newest export stamp across every entity view: "the lake is current as of".
 * Null on an empty lake or if the probe fails (freshness is advisory, never
 * a reason to fail a query).
 * @param {any} conn
 * @returns {Promise<string | null>}
 */
async function readAsOf(conn) {
  const union = ENTITIES.map(
    (e) => `SELECT max(exportedAt) AS t FROM ${e}`,
  ).join(" UNION ALL ");
  try {
    const reader = await conn.runAndReadAll(`SELECT max(t) FROM (${union})`);
    const v = reader.getRowsJS()[0]?.[0];
    return v instanceof Date ? v.toISOString() : v == null ? null : String(v);
  } catch {
    return null;
  }
}

/** Mark the warm cache stale so the next query rebuilds from scratch. */
function invalidateWarm() {
  warm = null;
}

// ---- Query execution --------------------------------------------------------

// Result caps. API Gateway responses max out at 10 MB; keep well under it and
// cap rows so a careless query can't dump the whole lake into JSON.
const MAX_ROWS = 10_000;
const MAX_RESULT_BYTES = 5 * 1024 * 1024;
// Read per query so tests can shrink it.
const rowCap = { value: MAX_ROWS };

/**
 * @typedef {{
 *   columns: string[],
 *   rows: unknown[][],
 *   truncated: boolean,
 *   elapsedMs: number,
 *   asOf: string | null,
 * }} QueryResult
 */

/**
 * Run one read-only SQL statement (optionally parameterized with `$name`
 * placeholders) against the lake views.
 * @param {string} bucket
 * @param {string} sql
 * @param {Record<string, unknown>} [params] bound through a prepared
 *   statement; never interpolated
 * @returns {Promise<QueryResult>}
 */
export async function runQuery(bucket, sql, params) {
  const start = Date.now();
  const state = await getWarm(bucket);
  // The wrapper is the statement-shape guard: anything that isn't a single
  // SELECT-shaped statement (DDL, PRAGMA, SET, INSTALL, COPY, a second
  // statement after a semicolon) is a parser error inside a subquery.
  const wrapped = `SELECT * FROM (\n${stripTrailingSemicolon(sql)}\n)`;
  try {
    const reader = await execute(state.conn, wrapped, params);
    const columns = reader.columnNames();
    // getRowsJS materializes every row; cap by slicing after read. At current
    // lake sizes a full-scan result is far below the caps — revisit with a
    // streaming reader + LIMIT injection only if a query ever returns
    // millions of rows.
    const all = /** @type {any[][]} */ (reader.getRowsJS());
    const cap = rowCap.value;
    let truncated = all.length > cap;
    let rows = (truncated ? all.slice(0, cap) : all).map((row) =>
      row.map((v) => convertValue(v)),
    );

    let bytes = 0;
    for (const row of rows)
      for (const v of row) bytes += String(v ?? "").length;
    if (bytes > MAX_RESULT_BYTES) {
      const kept = Math.max(
        1,
        Math.floor((rows.length * MAX_RESULT_BYTES) / bytes),
      );
      rows = rows.slice(0, kept);
      truncated = true;
    }
    return {
      columns,
      rows,
      truncated,
      elapsedMs: Date.now() - start,
      asOf: state.asOf,
    };
  } catch (err) {
    const message = /** @type {Error} */ (err).message ?? String(err);
    if (USER_ERROR.test(message)) throw new QueryError("user", message);
    // Anything else is ours: S3/HTTP/IO, extension state, a view over a
    // partition that rotated away mid-flight. Rebuild from scratch next time.
    invalidateWarm();
    throw new QueryError("engine", message);
  }
}

/**
 * @param {any} conn
 * @param {string} sql
 * @param {Record<string, unknown> | undefined} params
 * @returns {Promise<any>} a DuckDB result reader
 */
async function execute(conn, sql, params) {
  if (!params || Object.keys(params).length === 0) {
    return conn.runAndReadAll(sql);
  }
  const prepared = await conn.prepare(sql);
  prepared.bind(params);
  return prepared.runAndReadAll();
}

/**
 * Convert a DuckDB value to a JSON-safe primitive. @duckdb/node-api returns
 * BigInt for BIGINT/HUGEINT, JS Date for TIMESTAMP/TIME TZ, and nested
 * objects/lists for nested types — stringify what JSON can't carry.
 * @param {any} v
 * @returns {unknown}
 */
function convertValue(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (t === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Result payload shape for the admin endpoints. Exported for tests.
 * @param {QueryResult} result
 * @returns {Record<string, unknown>}
 */
export function toQueryResponse(result) {
  return {
    columns: result.columns,
    rows: result.rows,
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
    asOf: result.asOf,
  };
}

// For tests: expose the internals so they can be exercised without a real S3.
export const _test = {
  MAX_ROWS,
  MAX_RESULT_BYTES,
  REFRESH_MS,
  convertValue,
  invalidateWarm,
  readAsOf,
  /**
   * Seed the warm cache with an existing connection.
   * @param {any} conn
   * @param {string} bucket
   * @param {{ empty?: string[], asOf?: string | null, refreshedAt?: number }} [opts]
   */
  seedWarm(conn, bucket, opts = {}) {
    warm = {
      conn,
      bucket,
      empty: new Set(opts.empty ?? []),
      refreshedAt: opts.refreshedAt ?? Date.now(),
      asOf: opts.asOf ?? null,
    };
  },
  /** @param {number} n */
  setRowCap(n) {
    rowCap.value = n;
  },
  /** @returns {WarmState | null} */
  warmState: () => warm,
};
