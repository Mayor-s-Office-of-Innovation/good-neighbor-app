// Ad-hoc DuckDB queries over the Parquet lake (ADR 0013 Phase 4, ad-hoc leg).
// The admin analytics query endpoint runs arbitrary read-only SQL from
// central-admin users against the same lake the scheduled reports use.
//
// Design notes:
// - One module-level DuckDB connection, created lazily and reused across
//   invocations on a warm Lambda sandbox. Views are rebuilt when the lake is
//   detected to have moved on (a new readings/checks date partition appears)
//   or when a query errors in a way that suggests stale state.
// - The boundary is IAM, not SQL parsing: the deployed role is read-only on
//   the lake (GetObject/ListBucket + kms:Decrypt). There is no SQL allowlist —
//   central admins can already run the same SQL from a laptop.
// - Views mirror reports.js createViews: latest-wins per (pk, sk) ordered by
//   exportedAt, built with union_by_name over the hive-partitioned Parquet.

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { DuckDBInstance } from "@duckdb/node-api";
import { logServerError } from "../lib/log-server-error.js";

// The analytics lake is always real AWS S3 — never the local MinIO harness
// bucket — and lives in us-west-2. The local harness exports MinIO-flavored
// AWS_* env creds plus an S3 endpoint override for the app services; the
// analytics leg must ignore both. Pin the real regional endpoint. Credentials
// resolve through the node chain with an explicit profile, which makes the
// chain skip the env stubs (AWS_PROFILE detection) and use the laptop's real
// credentials; the deployed Lambda sets no profile, so its container
// credentials resolve through the same chain.
const LAKE_REGION = "us-west-2";
const lakeCredentials = defaultProvider({
  profile: process.env.LAKE_AWS_PROFILE || undefined,
});
const s3 = new S3Client({
  region: LAKE_REGION,
  endpoint: `https://s3.${LAKE_REGION}.amazonaws.com`,
  credentialDefaultProvider: () => lakeCredentials,
});

// Every entity the converter writes (convert.js ENTITY_ORDER). reports.js only
// defines views for six of them; the query engine needs all nine so dashboards
// can join site/provider names onto activity rows.
export const ENTITIES = [
  "checks",
  "tasks",
  "conditions",
  "assessments",
  "artifacts",
  "analyses",
  "sites",
  "providers",
  "devices",
];

// The column set each entity's view must expose when the lake has no Parquet
// for that entity yet — matching the converter's promoted columns plus the
// derived pk/sk. Mirrors reports.js VIEW_COLUMNS with the three missing
// entities added from convert.js's toRow()/classifyItem promotions.
/** @type {Record<string, string[]>} */
const VIEW_COLUMNS = {
  checks: [
    "siteId",
    "checkId",
    "status",
    "startedAt",
    "completedAt",
    "grade",
    "gradeScore",
    "issueCount",
    "maxSeverity",
    "synthesizedAt",
    "exportedAt",
    "raw",
  ],
  tasks: [
    "siteId",
    "taskId",
    "shortId",
    "type",
    "kind",
    "category",
    "severity",
    "taskStatus",
    "createdAt",
    "resolvedAt",
    "exportedAt",
    "raw",
  ],
  conditions: [
    "siteId",
    "assessmentId",
    "conditionId",
    "canonicalCategory",
    "analyzerCategory",
    "severity",
    "outcome",
    "conditionStatus",
    "reportedAt",
    "exportedAt",
    "raw",
  ],
  assessments: [
    "siteId",
    "assessmentId",
    "policyVersion",
    "grade",
    "gradeScore",
    "reportedAt",
    "exportedAt",
    "raw",
  ],
  artifacts: [
    "siteId",
    "checkId",
    "artifactId",
    "capturedAt",
    "exportedAt",
    "raw",
  ],
  analyses: [
    "siteId",
    "checkId",
    "artifactId",
    "analysisStatus",
    "gradeScore",
    "analyzedAt",
    "exportedAt",
    "raw",
  ],
  sites: [
    "siteId",
    "providerId",
    "name",
    "address",
    "status",
    "exportedAt",
    "raw",
  ],
  providers: ["providerId", "name", "status", "exportedAt", "raw"],
  devices: ["siteId", "deviceId", "label", "status", "exportedAt", "raw"],
};

// Where DuckDB may write: extension downloads land under <home>/.duckdb.
// Lambda is read-only outside /tmp and sets no HOME; local runs may override.
const DUCKDB_HOME = process.env.DUCKDB_HOME_DIRECTORY || "/tmp";

/** @returns {string} */
function region() {
  return LAKE_REGION;
}

/**
 * Run SQL without echoing it on failure. The secret-creation statement embeds
 * the resolved AWS credentials; a DuckDB parse/validation error would surface
 * the full SQL (credentials included) in the exception message and any caller
 * that logs it. This wrapper replaces the statement with a scrubbed marker so
 * the failure is diagnosable but never carries credentials.
 * @param {any} conn
 * @param {string} sql statement to run
 * @param {string} scrubbed label logged in place of the statement on error
 * @returns {Promise<void>}
 */
async function runScrubbed(conn, sql, scrubbed) {
  try {
    await conn.run(sql);
  } catch (err) {
    const message = /** @type {Error} */ (err).message ?? String(err);
    logServerError("analytics-query", new Error(scrubbed), {
      extra: { duckdbError: message.slice(0, 500) },
    });
    throw new Error(`${scrubbed} (statement redacted)`);
  }
}

/**
 * Install httpfs + aws extensions and the S3 secret.
 *
 * DuckDB's own credential_chain provider doesn't resolve every local
 * credential source (e.g. macOS login-tool session creds fail secret
 * validation locally), while the AWS SDK's provider chain does. Resolve
 * through the SDK and pin an explicit S3 secret; the plain credential_chain
 * remains the fallback for the deployed Lambda's container credentials.
 * @param {any} conn
 */
async function installHttpfs(conn) {
  await conn.run(`SET home_directory = '${DUCKDB_HOME}';`);
  await conn.run(`INSTALL httpfs; LOAD httpfs; INSTALL aws; LOAD aws;`);
  try {
    const creds = await lakeCredentials();
    if (!creds.accessKeyId) throw new Error("no credentials resolved");
    const parts = [
      `KEY_ID '${creds.accessKeyId}'`,
      `SECRET '${creds.secretAccessKey}'`,
      creds.sessionToken ? `SESSION_TOKEN '${creds.sessionToken}'` : "",
      `REGION '${region()}'`,
    ].filter(Boolean);
    await runScrubbed(
      conn,
      `CREATE OR REPLACE SECRET gn_lake (${parts.join(", ")});`,
      "analytics secret creation failed",
    );
  } catch (err) {
    // Fallback path: the credential chain itself failed to resolve (no creds
    // at all), or the explicit secret was rejected. Either way the statement
    // above never reaches the caller with credentials in it.
    if (/** @type {Error} */ (err).message?.includes("statement redacted"))
      throw err;
    await conn.run(
      `CREATE OR REPLACE SECRET gn_lake (TYPE S3, PROVIDER CREDENTIAL_CHAIN);`,
    );
  }
}

/**
 * Does this entity prefix have any Parquet files? One cheap 1-object page per
 * entity, only when (re)building views.
 * @param {string} bucket
 * @param {string} entity
 * @returns {Promise<boolean>}
 */
async function hasParquetFiles(bucket, entity) {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `readings/${entity}/`,
      MaxKeys: 1,
    }),
  );
  return (res.KeyCount ?? 0) > 0;
}

/**
 * Latest partition date under readings/<entity>/, or null when there are none.
 * Used as the view-freshness signal: a new partition means new exports landed
 * and the views should be rebuilt.
 * @param {string} bucket
 * @param {string} entity
 * @returns {Promise<string | null>}
 */
async function latestPartition(bucket, entity) {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `readings/${entity}/`,
      MaxKeys: 1,
    }),
  );
  for (const obj of res.Contents ?? []) {
    const m = /readings\/[^/]+\/date=([^/]+)\//.exec(obj.Key ?? "");
    if (m) return m[1];
  }
  return null;
}

/**
 * Create the deduped views over the lake for all entities. Entities with no
 * Parquet yet get empty typed views so any dashboard SQL still binds.
 * @param {any} conn
 * @param {string} bucket
 * @param {{ install?: boolean }} [opts] set install=false when httpfs+secret
 *   are already installed (tests against local paths — the secret validates
 *   the AWS credential chain at CREATE time)
 */
export async function createAllViews(conn, bucket, opts = {}) {
  if (opts.install !== false) {
    await installHttpfs(conn);
  }
  const base = `s3://${bucket}/readings`;
  for (const entity of ENTITIES) {
    if (await hasParquetFiles(bucket, entity)) {
      // Latest-wins per primary key (pk/sk from the raw JSON column), ordered
      // by the export stamp — same semantics as reports.js.
      await conn.run(`
        CREATE OR REPLACE VIEW ${entity} AS
        SELECT * EXCLUDE (pk, sk) FROM (
          SELECT *,
                 raw->>'$.pk' AS pk,
                 raw->>'$.sk' AS sk
          FROM read_parquet('${base}/${entity}/*/*.parquet', hive_partitioning = true, union_by_name = true)
        )
        QUALIFY row_number() OVER (PARTITION BY pk, sk ORDER BY exportedAt DESC) = 1;
      `);
    } else {
      const cols = Object.entries(emptyViewSchema(VIEW_COLUMNS[entity]))
        .map(([name, type]) => `CAST(NULL AS ${type}) AS ${name}`)
        .concat(["CAST(NULL AS DATE) AS date"])
        .join(", ");
      await conn.run(`CREATE OR REPLACE VIEW ${entity} AS SELECT ${cols};`);
    }
  }
}

/**
 * DuckDB types for empty views — mirroring the converter's pinned schema:
 * exportedAt is TIMESTAMP, numerics BIGINT, everything else VARCHAR.
 * @param {string[]} columns
 * @returns {Record<string, string>}
 */
function emptyViewSchema(columns) {
  const ts = new Set(["exportedAt"]);
  const numeric = new Set([
    "gradeScore",
    "issueCount",
    "maxSeverity",
    "severity",
  ]);
  return Object.fromEntries(
    columns.map((c) => [
      c,
      ts.has(c) ? "TIMESTAMP" : numeric.has(c) ? "BIGINT" : "VARCHAR",
    ]),
  );
}

// ---- Warm-sandbox connection cache -------------------------------------------
// One DuckDB instance + connection per Lambda execution environment. Views are
// rebuilt when the lake advances (new partition for checks) or when a query
// fails in a way that suggests the cached views went stale.
/** @type {{ conn: any, bucket: string | null, checksPartition: string | null } | null} */
let warm = null;

/**
 * Get (or create) the warm connection with views current for `bucket`.
 * @param {string} bucket
 * @returns {Promise<any>}
 */
async function getWarmConnection(bucket) {
  if (!warm || warm.bucket !== bucket) {
    if (warm) {
      try {
        warm.conn.closeSync();
      } catch {
        // a broken connection is fine to abandon
      }
    }
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    await createAllViews(conn, bucket);
    warm = {
      conn,
      bucket,
      checksPartition: await latestPartition(bucket, "checks"),
    };
    return conn;
  }
  // Freshness check is one cheap ListObjectsV2; a new partition triggers a
  // view rebuild (data changes only every 6h, so this rarely fires).
  const latest = await latestPartition(bucket, "checks");
  if (latest && latest !== warm.checksPartition) {
    await createAllViews(warm.conn, bucket);
    warm.checksPartition = latest;
  }
  return warm.conn;
}

/**
 * Mark the warm cache stale so the next query rebuilds views.
 * @returns {void}
 */
function invalidateWarm() {
  warm = null;
}

// Result caps. API Gateway responses max out at 10 MB; keep well under it and
// cap rows so a careless dashboard query can't dump the whole lake into JSON.
const MAX_ROWS = 10_000;
const MAX_RESULT_BYTES = 5 * 1024 * 1024;

/**
 * Run one read-only SQL query against the lake views.
 * @param {string} bucket
 * @param {string} sql
 * @returns {Promise<{ columns: string[], rows: unknown[][], truncated: boolean, elapsedMs: number }>}
 */
export async function runQuery(bucket, sql) {
  const start = Date.now();
  const conn = await getWarmConnection(bucket);
  try {
    const reader = await conn.runAndReadAll(sql);
    const columns = reader.columnNames();
    // getRowsJS materializes every row; cap by slicing after read. At current
    // lake sizes a full scan result is far below the caps — revisit with a
    // streaming reader + LIMIT injection only if a dashboard query ever
    // returns millions of rows.
    const all = reader.getRowsJS();
    const cap = MAX_ROWS_SETABLE.value;
    const truncated = all.length > cap;
    /** @type {unknown[][]} */
    const rows = truncated ? all.slice(0, cap) : all;
    const converted = rows.map((row) =>
      row.map((/** @type {any} */ v) => convertValue(v)),
    );

    let bytes = 0;
    for (const row of converted)
      for (const v of row) bytes += String(v ?? "").length;
    if (bytes > MAX_RESULT_BYTES) {
      const kept = Math.max(
        1,
        Math.floor((converted.length * MAX_RESULT_BYTES) / bytes),
      );
      return {
        columns,
        rows: converted.slice(0, kept),
        truncated: true,
        elapsedMs: Date.now() - start,
      };
    }
    return {
      columns,
      rows: converted,
      truncated,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    const message = /** @type {Error} */ (err).message ?? String(err);
    // A stale S3 view (partition rotated away mid-flight) can leave the
    // connection unusable; invalidate so the next attempt rebuilds views
    // from scratch. Surface the error to the caller this time.
    const stale = /HTTP|IO Error|S3|fetch|reset/i.test(message);
    if (stale) invalidateWarm();
    const error = new Error(`query_failed: ${message}`);
    throw error;
  }
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
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (v?.micros !== undefined && v?.days !== undefined) return String(v);
  if (t === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Result payload shape for the admin endpoint. Exported for tests.
 * @param {{ columns: string[], rows: unknown[][], truncated: boolean, elapsedMs: number }} result
 * @returns {Record<string, unknown>}
 */
export function toQueryResponse(result) {
  return {
    columns: result.columns,
    rows: result.rows,
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
  };
}

// For tests: expose the internals so they can be exercised without a real S3.
export const _test = {
  VIEW_COLUMNS,
  ENTITIES,
  MAX_ROWS,
  MAX_RESULT_BYTES,
  convertValue,
  invalidateWarm,
  /**
   * Seed the warm cache with an existing connection (tests).
   * @param {any} conn
   * @param {string} bucket
   * @param {string | null} partition
   * @returns {void}
   */
  seedWarm(conn, bucket, partition) {
    warm = { conn, bucket, checksPartition: partition };
  },
  /** Test hook to temporarily lower the row cap. */
  MAX_ROWS_ORIGINAL: MAX_ROWS,
  /**
   * @param {number} n
   * @returns {void}
   */
  MAX_ROWS_SET(n) {
    MAX_ROWS_SETABLE.value = n;
  },
  /** @returns {{ conn: any, bucket: string | null, checksPartition: string | null } | null} */
  warmState: () => warm,
};

// MAX_ROWS is read per-query from this holder so tests can shrink it.
const MAX_ROWS_SETABLE = { value: MAX_ROWS };
