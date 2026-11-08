// Sets up the lake in MinIO the way the Lambdas leave it, so the specs exercise
// the real S3 reads that the admin suite's mock skips.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
  paginateListObjectsV2,
} from "@aws-sdk/client-s3";
import { test as base, expect } from "@playwright/test";
import { DuckDBInstance } from "@duckdb/node-api";
import { s3Source } from "../../backend/src/reporting/api/snapshot.js";
import { LATEST_PROJECTION_KEY } from "../../backend/src/reporting/contract.js";
import { writeLocalLake } from "../../backend/src/reporting/local-lake.js";
import {
  buildLatestProjection,
  publishProjection,
} from "../../backend/src/reporting/publish-projection.js";
import { blankConfigJs, collectPageErrors } from "../helpers/admin-page.js";
import { INSIGHTS_EMULATOR_URLS } from "../helpers/ports.js";

export const test = base.extend({
  page: async ({ page }, use) => {
    const pageErrors = collectPageErrors(page);
    await use(page);
    expect(pageErrors, "uncaught page errors").toEqual([]);
  },
});
export { expect };

const lake = new S3Client({ forcePathStyle: true });
const bucket = () => /** @type {string} */ (process.env.LAKE_BUCKET);
// Its own bucket, so this build can't replace the snapshot the page specs read.
const BUILD_BUCKET = "gnp-local-insights-e2e-build";
// The smallest lake that still gives the build a Site and a Check to join.
const LAKE_ITEMS = [
  { pk: "SITE#s1", sk: "#META", siteId: "s1", status: "active" },
  {
    pk: "SITE#s1",
    sk: "CHECK#c1",
    siteId: "s1",
    checkId: "c1",
    status: "completed",
    flowType: "perimeter",
    startedAt: "2026-11-02T16:00:00.000Z",
    completedAt: "2026-11-02T16:10:00.000Z",
  },
];

export async function uploadProjection() {
  // Imported here: it builds a projection in DuckDB when loaded, which most specs never use.
  const { writeSyntheticProjection } = await import(
    "../../backend/src/reporting/api/test-projection.js"
  );
  const tmp = await mkdtemp(join(tmpdir(), "insights-emulator-"));
  /** @type {DuckDBInstance | undefined} */
  let instance;
  /** @type {import("@duckdb/node-api").DuckDBConnection | undefined} */
  let conn;
  try {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    const dir = join(tmp, "projection");
    const { manifest, written } = await writeSyntheticProjection(conn, dir);
    await publishProjection({
      s3: lake,
      bucket: bucket(),
      dir,
      manifest,
      written,
    });
  } finally {
    conn?.closeSync();
    instance?.closeSync();
    await rm(tmp, { recursive: true, force: true });
  }
}

/** @param {string} dir */
async function uploadLakeFiles(dir) {
  await lake
    .send(new CreateBucketCommand({ Bucket: BUILD_BUCKET }))
    .catch((/** @type {any} */ err) => {
      if (err.name !== "BucketAlreadyOwnedByYou") throw err;
    });
  // MinIO's data folder outlives a run, so an older run's partitions would add rows.
  for await (const page of paginateListObjectsV2(
    { client: lake },
    { Bucket: BUILD_BUCKET, Prefix: "readings/" },
  )) {
    const keys = (page.Contents ?? []).map(({ Key }) => ({ Key }));
    if (!keys.length) continue;
    const { Errors } = await lake.send(
      new DeleteObjectsCommand({
        Bucket: BUILD_BUCKET,
        Delete: { Objects: keys },
      }),
    );
    // DeleteObjects answers 200 when a key fails, and a leftover file would add rows.
    if (Errors?.length)
      throw new Error(
        `couldn't clear ${Errors.length} build lake files, first ${Errors[0].Key}: ${Errors[0].Code}`,
      );
  }
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const file of files.filter((f) => f.isFile())) {
    const path = join(file.parentPath, file.name);
    await lake.send(
      new PutObjectCommand({
        Bucket: BUILD_BUCKET,
        Key: `readings/${path.slice(dir.length + 1)}`,
        Body: await readFile(path),
      }),
    );
  }
}

/** Unit tests fake S3, so only this proves the build can read Parquet over httpfs. */
export async function buildFromLakeFiles() {
  const tmp = await mkdtemp(join(tmpdir(), "insights-emulator-build-"));
  /** @type {DuckDBInstance | undefined} */
  let instance;
  /** @type {import("@duckdb/node-api").DuckDBConnection | undefined} */
  let conn;
  try {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await writeLocalLake(conn, join(tmp, "lake"), LAKE_ITEMS, {
      exportedAt: "2026-11-05T06:00:00.000Z",
      exportId: "e1",
    });
    await uploadLakeFiles(join(tmp, "lake"));
    const { prefix } = await buildLatestProjection({
      bucket: BUILD_BUCKET,
      now: () => new Date("2026-11-05T07:00:00.000Z"),
    });
    return await s3Source({ s3: lake, bucket: BUILD_BUCKET }).load(prefix);
  } finally {
    conn?.closeSync();
    instance?.closeSync();
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function deleteLatestProjection() {
  await lake.send(
    new DeleteObjectCommand({ Bucket: bucket(), Key: LATEST_PROJECTION_KEY }),
  );
}

/**
 * The emulator stack has no Cognito, so the page signs in as the local debug admin.
 * @param {import("@playwright/test").Page} page
 */
export async function useLocalApi(page) {
  await page.addInitScript((apiBase) => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase,
      localDebugAdmin: true,
      insightsEnabled: true,
    };
  }, INSIGHTS_EMULATOR_URLS.api);
  await blankConfigJs(page);
}
