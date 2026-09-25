// Shared DuckDB view layer over the Parquet lake (ADR 0013). Both consumers —
// the scheduled report Lambda (reports.js) and the admin query engine
// (query.js) — build their views here so they agree on entities, columns,
// types and latest-wins semantics. The column set is the converter's own
// (convert.js ENTITY_COLUMNS), so there is exactly one schema to keep.
//
// Views:
// - One view per entity, named after it (checks, tasks, …), over
//   readings/<entity>/date=YYYY-MM-DD/*.parquet with hive partitioning.
// - Latest-wins per primary key: QUALIFY row_number() OVER (PARTITION BY
//   pk, sk ORDER BY exportedAt DESC) = 1. Mutations are real (AP8 header
//   synthesis, task transitions, condition answers), so this is not optional.
// - The hive `date` column is read as VARCHAR and exposed as
//   TRY_CAST(date AS DATE). Rows without a usable timestamp land in
//   date=unknown; letting DuckDB autodetect the partition type would flip the
//   whole column to VARCHAR the moment that partition exists and break every
//   `date >= …` filter. With the cast, those rows just have a NULL date.
// - Entities with no Parquet yet get an empty stand-in view with the exact
//   expected columns, so report and dashboard SQL still binds (read_parquet
//   throws on an empty glob).
//
// DuckDB re-plans a view on every query, so new Parquet files under an
// existing view's glob are picked up without rebuilding anything. The only
// transition that needs a rebuild is empty stand-in → real view.

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { ENTITY_COLUMNS, columnSchema } from "./convert.js";
import { logServerError } from "../lib/log-server-error.js";

/** Every entity the converter writes, in converter order. */
export const ENTITIES = Object.keys(ENTITY_COLUMNS);

// Where DuckDB may write: extension downloads land under <home>/.duckdb. The
// Lambda filesystem is read-only outside /tmp and sets no HOME, so DuckDB's
// default fails with "Can't find the home directory". Verified against
// @duckdb/node-api 1.5.5 with HOME unset: SET home_directory to an existing
// directory installs extensions under it; SET extension_directory alone still
// raises the home-directory error. The directory must already exist (/tmp
// always does on Lambda). Override for a laptop run that wants its usual
// ~/.duckdb cache.
const DUCKDB_HOME = process.env.DUCKDB_HOME_DIRECTORY || "/tmp";

/**
 * @typedef {() => Promise<{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }>} CredentialProvider
 */

/**
 * Install httpfs + aws and create the S3 secret.
 *
 * On Lambda the CREDENTIAL_CHAIN provider resolves the execution role's
 * container credentials and nothing is ever written into the catalog. Pass
 * `credentials` only for a laptop run whose credential source DuckDB's own
 * chain can't read (e.g. login-tool session creds): the SDK chain resolves
 * them and an explicit-key secret is created instead.
 * @param {any} conn
 * @param {{ credentials?: CredentialProvider, region?: string }} [opts]
 */
export async function installHttpfs(conn, opts = {}) {
  // Must precede any INSTALL/LOAD: the extension directory derives from it.
  await conn.run(`SET home_directory = '${DUCKDB_HOME}';`);
  // The CREDENTIAL_CHAIN secret provider lives in the aws extension, not
  // httpfs; load it explicitly rather than relying on autoload at CREATE time.
  await conn.run(`INSTALL httpfs; LOAD httpfs; INSTALL aws; LOAD aws;`);
  if (!opts.credentials) {
    await conn.run(
      `CREATE OR REPLACE SECRET gn_lake (TYPE S3, PROVIDER CREDENTIAL_CHAIN);`,
    );
    return;
  }
  const creds = await opts.credentials();
  if (!creds?.accessKeyId) throw new Error("lake credentials did not resolve");
  const parts = [
    `TYPE S3`,
    `KEY_ID '${creds.accessKeyId}'`,
    `SECRET '${creds.secretAccessKey}'`,
    creds.sessionToken ? `SESSION_TOKEN '${creds.sessionToken}'` : "",
    opts.region ? `REGION '${opts.region}'` : "",
  ].filter(Boolean);
  await runScrubbed(
    conn,
    `CREATE OR REPLACE SECRET gn_lake (${parts.join(", ")});`,
    "lake secret creation failed",
  );
}

/**
 * Run SQL without echoing it on failure. The secret-creation statement embeds
 * resolved AWS credentials; a DuckDB parse/validation error would surface the
 * full SQL (credentials included) in the exception message and any caller
 * that logs it. This wrapper logs a scrubbed marker plus the engine message
 * and rethrows without the statement.
 * @param {any} conn
 * @param {string} sql
 * @param {string} scrubbed
 * @returns {Promise<void>}
 */
async function runScrubbed(conn, sql, scrubbed) {
  try {
    await conn.run(sql);
  } catch (err) {
    const message = /** @type {Error} */ (err).message ?? String(err);
    logServerError("lake-views", new Error(scrubbed), {
      extra: { duckdbError: message.slice(0, 500) },
    });
    throw new Error(`${scrubbed} (statement redacted)`);
  }
}

/**
 * Does this entity prefix have any Parquet files? One 1-object page per
 * entity, only when (re)building views.
 * @param {{ send: (cmd: any) => Promise<any> }} s3
 * @param {string} bucket
 * @param {string} entity
 * @returns {Promise<boolean>}
 */
export async function hasParquetFiles(s3, bucket, entity) {
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
 * The CREATE VIEW statement for one entity over a lake base path
 * (`s3://bucket/readings` in production, a local directory in tests).
 * @param {string} base
 * @param {string} entity
 * @returns {string}
 */
export function lakeViewSql(base, entity) {
  // union_by_name tolerates schema drift between exports; the converter pins
  // column types so real drift shouldn't happen. pk/sk come from the raw JSON
  // column with `->>` (VARCHAR, not JSON-typed).
  return `
    CREATE OR REPLACE VIEW ${entity} AS
    SELECT * EXCLUDE (pk, sk, date), TRY_CAST(date AS DATE) AS date FROM (
      SELECT *,
             raw->>'$.pk' AS pk,
             raw->>'$.sk' AS sk
      FROM read_parquet(
        '${base}/${entity}/*/*.parquet',
        hive_partitioning = true,
        union_by_name = true,
        hive_types = {'date': 'VARCHAR'}
      )
    )
    QUALIFY row_number() OVER (PARTITION BY pk, sk ORDER BY exportedAt DESC) = 1;
  `;
}

/**
 * An empty stand-in view with the converter's exact columns and types plus the
 * hive `date` column, so SQL written against the real view binds.
 * @param {string} entity
 * @returns {string}
 */
export function emptyViewSql(entity) {
  const columns = ENTITY_COLUMNS[entity];
  if (!columns) throw new Error(`unknown lake entity: ${entity}`);
  const cols = Object.entries(columnSchema(columns))
    .map(([name, type]) => `CAST(NULL AS ${type}) AS ${name}`)
    .concat(["CAST(NULL AS DATE) AS date"])
    .join(", ");
  return `CREATE OR REPLACE VIEW ${entity} AS SELECT ${cols} WHERE false;`;
}

/**
 * Build the canonical views over the lake bucket.
 * @param {any} conn
 * @param {string} bucket
 * @param {{
 *   s3: { send: (cmd: any) => Promise<any> },
 *   install?: boolean,
 *   entities?: string[],
 *   credentials?: CredentialProvider,
 *   region?: string,
 * }} opts `install: false` when httpfs + the secret are already set up (the
 *   secret validates the credential chain at CREATE time, so tests skip it);
 *   `entities` to rebuild a subset (defaults to all).
 * @returns {Promise<{ empty: string[] }>} entities that got an empty stand-in
 *   view — the ones worth re-probing later.
 */
export async function createViews(conn, bucket, opts) {
  const { s3, install = true, entities = ENTITIES } = opts;
  if (!s3) throw new Error("createViews requires an s3 client");
  if (install) {
    await installHttpfs(conn, {
      credentials: opts.credentials,
      region: opts.region,
    });
  }
  const base = `s3://${bucket}/readings`;
  /** @type {string[]} */
  const empty = [];
  for (const entity of entities) {
    if (await hasParquetFiles(s3, bucket, entity)) {
      await conn.run(lakeViewSql(base, entity));
    } else {
      await conn.run(emptyViewSql(entity));
      empty.push(entity);
    }
  }
  return { empty };
}

/**
 * Freeze the engine for untrusted SQL. Disables the local filesystem — which
 * otherwise lets any SELECT read `/proc/self/environ` (the execution role's
 * credentials) or anything else on the sandbox disk — and locks every
 * configuration option so a query can't turn that back on, raise memory or
 * thread limits, or change the home/extension directories. GLOBAL scope so
 * the lock holds for every connection on the instance. Views can still be
 * created after this (they are catalog objects, not configuration), so the
 * empty→real rebuild keeps working; extensions must be installed BEFORE
 * calling this. Only for engines that never write local files: the report
 * Lambda copies CSVs to /tmp and must not lock down.
 * @param {any} conn
 */
export async function lockdown(conn) {
  await conn.run(`SET GLOBAL disabled_filesystems = 'LocalFileSystem';`);
  await conn.run(`SET GLOBAL lock_configuration = true;`);
}

/**
 * Strip one trailing statement terminator (and trailing whitespace) so a
 * standalone-runnable statement can be embedded in `COPY (...)` or
 * `SELECT * FROM (...)`: a semicolon closes the statement before the
 * wrapper's closing parenthesis, which is a parser error.
 * @param {string} sql
 * @returns {string}
 */
export function stripTrailingSemicolon(sql) {
  return sql.replace(/[;\s]+$/, "").trimEnd();
}
