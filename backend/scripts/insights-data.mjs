// One command for Insights test data: generate a seeded year of synthetic
// staff-app records, load them into DynamoDB Local, export the table in the
// PITR export's file format to MinIO, run the real converter over it, build
// the Insights projection, and check its totals against the generator's
// answers.
//
//   npm run insights:data -w backend -- [--sites 24] [--seed 410] [--keep]
//
// Starts its own in-memory DynamoDB Local and a throwaway MinIO on spare
// ports, using the binaries `npm run local:services` already put in
// backend/.local, so it never touches the dev stack's data. Needs Java 17+.
// Extracts land in backend/.local/insights-data/.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import {
  CreateTableCommand,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { TABLE_SCHEMA } from "./lib/ensure-infra.mjs";

const { values: args } = parseArgs({
  options: {
    sites: { type: "string", default: "24" },
    seed: { type: "string", default: "410" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = join(backendDir, ".local");
const outDir = args.out ?? join(localDir, "insights-data");
const MARKER = ".insights-data";
// Each run replaces its folder, so never wipe one this script didn't write.
if (
  existsSync(outDir) &&
  (await readdir(outDir)).length > 0 &&
  !existsSync(join(outDir, MARKER)) &&
  !existsSync(join(outDir, "check.json"))
) {
  console.error(
    `[insights-data] ${outDir} has other files; pick an empty --out folder`,
  );
  process.exit(1);
}
const SITES = Number(args.sites);
const SEED = Number(args.seed);
if (!Number.isInteger(SITES) || SITES < 1 || !Number.isInteger(SEED)) {
  console.error("[insights-data] --sites and --seed must be whole numbers");
  process.exit(1);
}
const DDB_PORT = Number(process.env.INSIGHTS_DDB_PORT ?? 8461);
const S3_PORT = Number(process.env.INSIGHTS_S3_PORT ?? 9461);
const TABLE = "gnp-insights-synthetic";
const BUCKET = "gnp-insights-lake";
const CREDS = {
  accessKeyId: "insightslocal",
  secretAccessKey: "insightslocalsecret",
};

// The converter builds its S3 client at import, so point it at MinIO first.
Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: CREDS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
  // A real session token from the shell would break the MinIO signatures.
  AWS_SESSION_TOKEN: "",
  AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${S3_PORT}`,
  LAKE_BUCKET: BUCKET,
});
const { convertExport, sqlString } = await import(
  "../src/analytics/convert.js"
);
const { generateYear } = await import("../src/reporting/synthetic/generate.js");
const { compareWithAnswers } = await import(
  "../src/reporting/synthetic/verify.js"
);
const { createLocalViews } = await import("../src/reporting/local-lake.js");
const { buildProjection, readLakeInputs, writeProjection } = await import(
  "../src/reporting/projection.js"
);

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
/** @type {string[]} */
const crashes = [];
let stopping = false;
const stop = () => {
  stopping = true;
  children.forEach((c) => c.kill("SIGTERM"));
};
process.on("exit", stop);
// Node skips "exit" on a signal, which would leave the emulators running.
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => process.exit(130));

/**
 * @param {string} label
 * @param {() => Promise<unknown>} probe
 */
async function waitFor(label, probe) {
  for (let i = 0; i < 120; i += 1) {
    if (crashes.length) throw new Error(crashes.join("; "));
    try {
      await probe();
      return;
    } catch (err) {
      // The service answered, so retrying won't help; show its error.
      if (/** @type {any} */ (err)?.$metadata?.httpStatusCode) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${label} did not start`);
}

/**
 * @param {string} label
 * @param {() => Promise<any> | any} work
 * @returns {Promise<any>}
 */
async function step(label, work) {
  const started = Date.now();
  const result = await work();
  console.log(
    `[insights-data] ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  return result;
}

/**
 * True when something already listens there; its replies would look like a
 * failed start, so stop early with a clear message instead.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** @returns {Promise<string>} the scratch folder to remove afterwards */
async function startEmulators() {
  for (const [name, port] of [
    ["INSIGHTS_DDB_PORT", DDB_PORT],
    ["INSIGHTS_S3_PORT", S3_PORT],
    ["INSIGHTS_S3_PORT", S3_PORT + 1],
  ])
    if (await portInUse(Number(port)))
      throw new Error(`Port ${port} is in use; set ${name} to a free port.`);
  const jarDir = join(localDir, "dynamodb-local");
  const minio = join(localDir, "minio");
  if (!existsSync(join(jarDir, "DynamoDBLocal.jar")) || !existsSync(minio))
    throw new Error(
      "Missing backend/.local/dynamodb-local or backend/.local/minio. Run `npm run local:services -w backend` once to install them.",
    );
  const scratch = await mkdtemp(join(tmpdir(), "insights-emulators-"));
  const minioData = join(scratch, "minio");
  children.push(
    spawn(
      "java",
      [
        `-Djava.library.path=${join(jarDir, "DynamoDBLocal_lib")}`,
        "-jar",
        join(jarDir, "DynamoDBLocal.jar"),
        "-inMemory",
        "-sharedDb",
        "-port",
        String(DDB_PORT),
      ],
      // DynamoDB Local drops a metadata file in its working directory.
      { stdio: "ignore", cwd: scratch },
    ),
  );
  children.push(
    spawn(
      minio,
      [
        "server",
        minioData,
        "--address",
        `127.0.0.1:${S3_PORT}`,
        "--console-address",
        `127.0.0.1:${S3_PORT + 1}`,
      ],
      {
        stdio: "ignore",
        // The converter asks for KMS encryption; a throwaway key satisfies it.
        env: {
          ...process.env,
          MINIO_ROOT_USER: CREDS.accessKeyId,
          MINIO_ROOT_PASSWORD: CREDS.secretAccessKey,
          MINIO_KMS_SECRET_KEY: `insights-local:${randomBytes(32).toString("base64")}`,
        },
      },
    ),
  );
  for (const [name, child] of [
    ["DynamoDB Local (needs Java 17+ on PATH)", children[0]],
    ["MinIO", children[1]],
  ]) {
    child.once("error", (err) => crashes.push(`${name}: ${err.message}`));
    child.once("exit", (code) => {
      if (!stopping) crashes.push(`${name} exited with code ${code}`);
    });
  }
  return scratch;
}

const ddb = new DynamoDBClient({
  endpoint: `http://127.0.0.1:${DDB_PORT}`,
  region: "us-east-1",
  credentials: CREDS,
});
const doc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({
  endpoint: `http://127.0.0.1:${S3_PORT}`,
  region: "us-east-1",
  credentials: CREDS,
  forcePathStyle: true,
});

/** @param {Record<string, any>[]} items */
async function load(items) {
  const batches = [];
  for (let i = 0; i < items.length; i += 25)
    batches.push(items.slice(i, i + 25));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      let requests = batches[next++].map((Item) => ({ PutRequest: { Item } }));
      while (requests.length) {
        const res = await doc.send(
          new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }),
        );
        requests = /** @type {any[]} */ (res.UnprocessedItems?.[TABLE] ?? []);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

/**
 * Scan the table into the files a full PITR export writes, so the real
 * converter reads it unchanged.
 * @param {string} exportId
 * @returns {Promise<{ summaryKey: string, count: number }>}
 */
async function exportTable(exportId) {
  const base = `raw/AWSDynamoDB/${exportId}`;
  const segments = 4;
  const files = [];
  let count = 0;
  for (let segment = 0; segment < segments; segment += 1) {
    const lines = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName: TABLE,
          Segment: segment,
          TotalSegments: segments,
          ExclusiveStartKey,
        }),
      );
      for (const Item of page.Items ?? []) lines.push(JSON.stringify({ Item }));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const key = `${base}/data/part-${segment}.json.gz`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: gzipSync(lines.join("\n")),
      }),
    );
    files.push({ dataFileS3Key: key, itemCount: lines.length });
    count += lines.length;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${base}/manifest-files.json`,
      Body: files.map((f) => JSON.stringify(f)).join("\n"),
    }),
  );
  const summaryKey = `${base}/manifest-summary.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: summaryKey,
      Body: JSON.stringify({
        exportType: "FULL_EXPORT",
        itemCount: count,
        manifestFilesS3Key: `${base}/manifest-files.json`,
      }),
    }),
  );
  return { summaryKey, count };
}

/**
 * @param {string} prefix
 * @param {string} dir
 */
async function download(prefix, dir) {
  let ContinuationToken;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken,
      }),
    );
    for (const { Key } of page.Contents ?? []) {
      if (!Key) continue;
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
      const path = join(dir, Key.slice(prefix.length));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        Buffer.from(await /** @type {any} */ (res.Body).transformToByteArray()),
      );
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
}

let scratchDir = "";
try {
  scratchDir = await step("started DynamoDB Local and MinIO", startEmulators);
  await waitFor("DynamoDB Local", () =>
    ddb.send(new CreateTableCommand({ TableName: TABLE, ...TABLE_SCHEMA })),
  );
  await waitFor("MinIO", () =>
    s3.send(new CreateBucketCommand({ Bucket: BUCKET })),
  );

  const generated = await step("generated records", () =>
    generateYear({ seed: SEED, sites: SITES }),
  );
  console.log(
    `[insights-data] ${generated.items.length} items, ${Object.keys(generated.answers.profiles).length} Sites, ${generated.startDay} to ${generated.evaluatedAt}`,
  );
  await step("loaded into DynamoDB Local", () => load(generated.items));

  const exportId = `synthetic-${args.seed}`;
  const { summaryKey, count } = await step("exported the table to MinIO", () =>
    exportTable(exportId),
  );
  // A lost or overwritten item may not move any total, so count them too.
  if (count !== generated.items.length)
    throw new Error(
      `exported ${count} items but generated ${generated.items.length}`,
    );
  const converted = await step("converted the export to Parquet", () =>
    convertExport(BUCKET, summaryKey, generated.evaluatedAt),
  );
  console.log(
    `[insights-data] exported ${count} items; converter kept ${converted.rows} reporting rows in ${converted.files.length} files`,
  );

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  // Marks the folder as this script's, so a failed run can be rerun.
  await writeFile(join(outDir, MARKER), "");
  const lakeDir = join(outDir, "lake");
  await step("copied the lake from MinIO", () =>
    download("readings/", lakeDir),
  );
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await createLocalViews(conn, lakeDir);
  const snapshotId = generated.evaluatedAt.replace(/[:.]/g, "-");
  const projectionDir = join(outDir, "projection");
  const { projection, written } = await step(
    "built the Insights projection",
    async () => {
      const built = buildProjection(await readLakeInputs(conn), {
        evaluatedAt: generated.evaluatedAt,
        snapshotId,
      });
      return {
        projection: built,
        written: await writeProjection(conn, built, projectionDir),
      };
    },
  );
  // Same layout the build job will use in the lake bucket; latest.json goes last.
  const prefix = `projections/${projection.manifest.contractVersion}/${snapshotId}`;
  for (const name of written)
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${prefix}/${name}`,
        Body: await readFile(join(projectionDir, name)),
      }),
    );
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: "projections/latest.json",
      Body: JSON.stringify({ prefix, snapshotId }),
    }),
  );
  // Check the written files, not the in-memory rows, so a Parquet bug shows.
  /** @type {Record<string, Record<string, any>[]>} */
  const extracts = {};
  for (const name of ["site_days", "site_contacts"])
    extracts[name] = (
      await conn.runAndReadAll(
        `SELECT * FROM ${sqlString(join(projectionDir, `${name}.parquet`))}`,
      )
    ).getRowObjectsJS();
  conn.closeSync();

  const result = compareWithAnswers(
    /** @type {any} */ (extracts),
    generated.answers,
  );
  await writeFile(
    join(outDir, "answers.json"),
    JSON.stringify(generated.answers, null, 2),
  );
  await writeFile(
    join(outDir, "check.json"),
    JSON.stringify({ ...result, manifest: projection.manifest }, null, 2),
  );
  console.log(`[insights-data] totals: ${JSON.stringify(result.totals)}`);
  console.log(
    `[insights-data] data quality: ${JSON.stringify(projection.manifest.dataQuality)}`,
  );
  if (result.mismatches.length) {
    console.error(
      `[insights-data] ${result.mismatches.length} of ${result.checked} totals differ from the answers:`,
    );
    for (const line of result.mismatches.slice(0, 20))
      console.error(`  ${line}`);
    process.exitCode = 1;
  } else
    console.log(
      `[insights-data] all ${result.checked} totals match the answers. Extracts: ${projectionDir}`,
    );
  if (args.keep) {
    console.log(
      `[insights-data] emulators left running: DynamoDB Local :${DDB_PORT}, MinIO :${S3_PORT} (Ctrl-C to stop)`,
    );
    await new Promise(() => {});
  }
} finally {
  if (!args.keep) {
    // MinIO keeps writing until it exits, so wait before removing its folder.
    const exited = children.map(
      (c) =>
        new Promise((done) =>
          c.exitCode !== null || c.signalCode !== null
            ? done(null)
            : c.once("exit", done),
        ),
    );
    stop();
    await Promise.all(exited);
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
}
