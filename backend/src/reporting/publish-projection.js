// Readers find a snapshot through latest.json, so it's written last and a
// failed run leaves the previous snapshot in place.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { createViews } from "../analytics/lake-views.js";
import { LATEST_PROJECTION_KEY, S3_TIMEOUTS } from "./contract.js";
import { buildProjection } from "./projection.js";

/** @typedef {import("./api/job-store.js").Sender} Sender */

const BUILD_FOLDER_PREFIX = "insights-projection-";
// Fit the Lambda's 2,048 MB. Spill gets half of /tmp, which also holds the DuckDB
// extensions and the finished files. Neither size has been measured on real data.
const DUCKDB_MEMORY_LIMIT = "1536MB";
const DUCKDB_SPILL_LIMIT = "1GiB";
// Each upload holds its whole file in memory, so only this many tables at once.
const UPLOADS_AT_ONCE = 2;

/**
 * S3 keys and folder names hold this ID, so it carries no colons or dots.
 * @param {string} evaluatedAt ISO timestamp
 */
export const snapshotIdFor = (evaluatedAt) => evaluatedAt.replace(/[:.]/g, "-");

// Lambda keeps /tmp after a build times out. Only there, because a laptop's
// temp folder may hold another worktree's build that is still running.
async function clearStaleBuildFolders() {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const root = tmpdir();
  for (const name of await readdir(root))
    if (name.startsWith(BUILD_FOLDER_PREFIX))
      await rm(join(root, name), { recursive: true, force: true });
}

/**
 * @param {{ s3: Sender, bucket: string, dir: string, manifest: Record<string, any>, written: string[] }} opts
 * @returns {Promise<{ prefix: string, snapshotId: string }>}
 */
export async function publishProjection({
  s3,
  bucket,
  dir,
  manifest,
  written,
}) {
  const snapshotId = String(manifest.snapshotId);
  const prefix = `projections/${manifest.contractVersion}/${snapshotId}`;
  const queue = [...written];
  const upload = async () => {
    try {
      for (let name = queue.shift(); name; name = queue.shift())
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${prefix}/${name}`,
            // Buffers, not streams: the AWS SDK won't retry a streamed body after a 503.
            Body: await readFile(join(dir, name)),
            ServerSideEncryption: "aws:kms",
          }),
        );
    } catch (err) {
      // The build has failed, so the other upload stops after its current file.
      queue.length = 0;
      throw err;
    }
  };
  // Settled first, so the caller's cleanup can't delete a file mid-upload.
  const uploads = await Promise.allSettled(
    Array.from({ length: UPLOADS_AT_ONCE }, upload),
  );
  const failed = uploads.find((u) => u.status === "rejected");
  if (failed) throw /** @type {PromiseRejectedResult} */ (failed).reason;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: LATEST_PROJECTION_KEY,
      Body: JSON.stringify({ prefix, snapshotId }),
      ContentType: "application/json",
      ServerSideEncryption: "aws:kms",
    }),
  );
  return { prefix, snapshotId };
}

/**
 * Tests pass `prepare` to read a local lake.
 * @param {{ s3?: Sender, bucket?: string, endpoint?: string, now?: () => Date, prepare?: (conn: any) => Promise<any> }} [opts]
 * @returns {Promise<{ prefix: string, snapshotId: string }>}
 */
export async function buildLatestProjection({
  endpoint = process.env.AWS_ENDPOINT_URL_S3,
  s3 = new S3Client({
    ...(endpoint ? { forcePathStyle: true } : {}),
    requestHandler: S3_TIMEOUTS,
  }),
  bucket = process.env.LAKE_BUCKET,
  now = () => new Date(),
  prepare,
} = {}) {
  if (!bucket) throw new Error("Missing LAKE_BUCKET");
  const evaluatedAt = now().toISOString();
  await clearStaleBuildFolders();
  const tmp = await mkdtemp(join(tmpdir(), BUILD_FOLDER_PREFIX));
  /** @type {DuckDBInstance | undefined} */
  let instance;
  /** @type {import("@duckdb/node-api").DuckDBConnection | undefined} */
  let conn;
  try {
    instance = await DuckDBInstance.create(":memory:", {
      // DuckDB spills to a folder under the working directory, which Lambda keeps read-only.
      temp_directory: join(tmp, "spill"),
      memory_limit: DUCKDB_MEMORY_LIMIT,
      max_temp_directory_size: DUCKDB_SPILL_LIMIT,
    });
    conn = await instance.connect();
    await (prepare
      ? prepare(conn)
      : createViews(conn, bucket, { s3, endpoint }));
    const dir = join(tmp, "projection");
    const { manifest, written } = await buildProjection(conn, dir, {
      evaluatedAt,
      snapshotId: snapshotIdFor(evaluatedAt),
    });
    // DuckDB keeps its memory until closed, and the upload needs room too.
    conn.closeSync();
    conn = undefined;
    instance.closeSync();
    instance = undefined;
    const published = await publishProjection({
      s3,
      bucket,
      dir,
      manifest,
      written,
    });
    console.log(
      JSON.stringify({ marker: "InsightsProjectionPublished", ...published }),
    );
    return published;
  } finally {
    conn?.closeSync();
    instance?.closeSync();
    await rm(tmp, { recursive: true, force: true });
  }
}
