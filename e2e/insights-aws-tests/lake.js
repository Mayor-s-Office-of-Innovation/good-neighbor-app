// The lake bucket as the Lambdas leave it, and the admin UI pointed at the real API.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { s3Source } from "../../backend/src/reporting/api/snapshot.js";
import { writeSyntheticProjection } from "../../backend/src/reporting/api/test-projection.js";
import { LATEST_PROJECTION_KEY } from "../../backend/src/reporting/contract.js";
import { writeLocalLake } from "../../backend/src/reporting/local-lake.js";
import {
  buildLatestProjection,
  publishProjection,
} from "../../backend/src/reporting/publish-projection.js";
import { blankConfigJs } from "../admin-tests/admin-mock.js";
import { INSIGHTS_AWS_URLS } from "../helpers/ports.js";

const lake = new S3Client({ forcePathStyle: true });
const bucket = () => /** @type {string} */ (process.env.LAKE_BUCKET);
// Its own bucket, so this build can't replace the snapshot the page specs read.
const BUILD_BUCKET = "gnp-local-insights-e2e-build";
// One Site with one finished Check, stored as the app stores them.
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
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const tmp = await mkdtemp(join(tmpdir(), "insights-aws-"));
  try {
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
    conn.closeSync();
    instance.closeSync();
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

/** Runs the Lambda's build unchanged against Parquet files in MinIO, then reads back what it published. */
export async function buildFromLakeFiles() {
  const tmp = await mkdtemp(join(tmpdir(), "insights-aws-build-"));
  const systemTmp = process.env.TMPDIR;
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await writeLocalLake(conn, join(tmp, "lake"), LAKE_ITEMS, {
      exportedAt: "2026-11-05T06:00:00.000Z",
      exportId: "e1",
    });
    await uploadLakeFiles(join(tmp, "lake"));
    // The build clears old build folders, which must not be another run's.
    process.env.TMPDIR = tmp;
    const { prefix } = await buildLatestProjection({ bucket: BUILD_BUCKET });
    return await s3Source({ s3: lake, bucket: BUILD_BUCKET }).load(prefix);
  } finally {
    if (systemTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = systemTmp;
    conn.closeSync();
    instance.closeSync();
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function deleteLatestProjection() {
  await lake.send(
    new DeleteObjectCommand({ Bucket: bucket(), Key: LATEST_PROJECTION_KEY }),
  );
}

/**
 * Sends the page's API calls to the local API, signed in as the local supervisor.
 * @param {import("@playwright/test").Page} page
 */
export async function useLocalApi(page) {
  await page.addInitScript((apiBase) => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase,
      localDebugAdmin: true,
      insightsEnabled: true,
    };
  }, INSIGHTS_AWS_URLS.api);
  await blankConfigJs(page);
}
