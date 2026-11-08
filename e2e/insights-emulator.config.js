import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import {
  INSIGHTS_EMULATOR_PORTS,
  INSIGHTS_EMULATOR_URLS,
} from "./helpers/ports.js";

/*
  Runs Insights on the real API, MinIO and ElasticMQ, which the admin suite's mock
  can't reach. Lambda role credentials, IAM and the size of /tmp stay unproven until
  the first deployed run. The build spec needs the network the first time, to fetch
  DuckDB's httpfs and aws extensions into backend/.local.
*/
const lakeBucket = "gnp-local-insights-e2e-lake";
const duckdbHome = fileURLToPath(
  new URL("../backend/.local/duckdb-insights-e2e", import.meta.url),
);
// DuckDB refuses a home directory that doesn't exist yet.
mkdirSync(duckdbHome, { recursive: true });
const env = {
  DYNAMO_TABLE: "gnp-local-insights-e2e",
  LOCAL_API_PORT: String(INSIGHTS_EMULATOR_PORTS.api),
  LOCAL_DDB_PORT: String(INSIGHTS_EMULATOR_PORTS.ddb),
  LOCAL_DDB_IN_MEMORY: "true",
  LOCAL_MQ_PORT: String(INSIGHTS_EMULATOR_PORTS.mq),
  LOCAL_MINIO_API_PORT: String(INSIGHTS_EMULATOR_PORTS.minio),
  LOCAL_MINIO_CONSOLE_PORT: String(INSIGHTS_EMULATOR_PORTS.minioConsole),
  LOCAL_MINIO_DATA_DIR: fileURLToPath(
    new URL("../backend/.local/minio-data-insights-e2e", import.meta.url),
  ),
  AWS_ENDPOINT_URL_DYNAMODB: INSIGHTS_EMULATOR_URLS.ddb,
  DYNAMO_ENDPOINT: INSIGHTS_EMULATOR_URLS.ddb,
  AWS_ENDPOINT_URL_SQS: INSIGHTS_EMULATOR_URLS.mq,
  SQS_QUEUE_URL: `${INSIGHTS_EMULATOR_URLS.mq}/local/gnp-local-insights-e2e`,
  AWS_ENDPOINT_URL_S3: INSIGHTS_EMULATOR_URLS.minio,
  // Blank, so downloads use production's presign client, not a developer's phone tunnel.
  S3_PUBLIC_PRESIGN_ENDPOINT: "",
  // MinIO refuses the lake writers' KMS encryption without a key. Nothing here is secret.
  MINIO_KMS_SECRET_KEY: `insights-e2e:${Buffer.alloc(32).toString("base64")}`,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "localdev",
  AWS_SECRET_ACCESS_KEY: "localdevsecret",
  LAKE_BUCKET: lakeBucket,
  INSIGHTS_PROJECTION_DIR: "",
  INSIGHTS_JOBS_BUCKET: "gnp-local-insights-e2e-jobs",
  INSIGHTS_JOBS_QUEUE_URL: `${INSIGHTS_EMULATOR_URLS.mq}/local/gnp-local-insights-e2e`,
  // Rechecks latest.json on every request, so each spec sees the lake it set up.
  INSIGHTS_REFRESH_MS: "0",
  // Kept where CI caches it, so each run doesn't download the extensions again.
  DUCKDB_HOME_DIRECTORY: duckdbHome,
  DUPLICATE_DETECTION_ENABLED: "false",
  DUPLICATE_QUEUE_URL: "",
  LOCAL_SITE_ADMIN_SEED: "false",
};
// Specs reach MinIO directly, so they need the same endpoint and keys.
Object.assign(process.env, env);

const vite =
  "../node_modules/.bin/vite --config ../admin-frontend/vite.config.js";
const dist = fileURLToPath(
  new URL("./test-results/insights-emulator-dist", import.meta.url),
);

export default defineConfig({
  outputDir: "./test-results/insights-emulator",
  testDir: "./insights-emulator-tests",
  forbidOnly: !!process.env.CI,
  // The specs share one API, one lake and one snapshot.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: INSIGHTS_EMULATOR_URLS.admin,
    headless: true,
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  },
  webServer: [
    {
      // Only what these specs use, so the stack boots faster and takes fewer ports.
      command:
        '../node_modules/.bin/concurrently -k -n svc,api,worker "npm:local:services" "npm:local:api" "npm:local:worker"',
      cwd: "../backend",
      url: `${INSIGHTS_EMULATOR_URLS.api}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${vite} build --outDir ${dist} --logLevel warn && ${vite} preview --outDir ${dist} --host 127.0.0.1 --port ${INSIGHTS_EMULATOR_PORTS.admin} --strictPort`,
      url: INSIGHTS_EMULATOR_URLS.admin,
      reuseExistingServer: false,
    },
  ],
});
