import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { INSIGHTS_AWS_PORTS, INSIGHTS_AWS_URLS } from "./helpers/ports.js";

/*
  Runs Insights on the real API, MinIO and ElasticMQ, which the admin suite's mock
  can't reach. Lambda role credentials, IAM and the size of /tmp stay unproven until
  the first deployed run. `empty-lake` runs first because the API rechecks latest.json
  only every 5 minutes, so "no projection yet" shows only before its first load.
*/
const lakeBucket = "gnp-local-insights-e2e-lake";
const env = {
  DYNAMO_TABLE: "gnp-local-insights-e2e",
  LOCAL_API_PORT: String(INSIGHTS_AWS_PORTS.api),
  LOCAL_DDB_PORT: String(INSIGHTS_AWS_PORTS.ddb),
  LOCAL_DDB_IN_MEMORY: "true",
  LOCAL_MQ_PORT: String(INSIGHTS_AWS_PORTS.mq),
  LOCAL_MINIO_API_PORT: String(INSIGHTS_AWS_PORTS.minio),
  LOCAL_MINIO_CONSOLE_PORT: String(INSIGHTS_AWS_PORTS.minioConsole),
  LOCAL_MINIO_DATA_DIR: fileURLToPath(
    new URL("../backend/.local/minio-data-insights-e2e", import.meta.url),
  ),
  AWS_ENDPOINT_URL_DYNAMODB: INSIGHTS_AWS_URLS.ddb,
  DYNAMO_ENDPOINT: INSIGHTS_AWS_URLS.ddb,
  AWS_ENDPOINT_URL_SQS: INSIGHTS_AWS_URLS.mq,
  SQS_QUEUE_URL: `${INSIGHTS_AWS_URLS.mq}/local/gnp-local-insights-e2e`,
  AWS_ENDPOINT_URL_S3: INSIGHTS_AWS_URLS.minio,
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
  INSIGHTS_JOBS_QUEUE_URL: `${INSIGHTS_AWS_URLS.mq}/local/gnp-local-insights-e2e`,
  DUPLICATE_DETECTION_ENABLED: "false",
  DUPLICATE_QUEUE_URL: "",
  LOCAL_SITE_ADMIN_SEED: "false",
};
// Specs reach MinIO directly, so they need the same endpoint and keys.
Object.assign(process.env, env);

const vite =
  "../node_modules/.bin/vite --config ../admin-frontend/vite.config.js";
const dist = fileURLToPath(
  new URL("./test-results/insights-aws-dist", import.meta.url),
);

export default defineConfig({
  outputDir: "./test-results/insights-aws",
  testDir: "./insights-aws-tests",
  forbidOnly: !!process.env.CI,
  // The specs share one API, one lake and one snapshot.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  projects: [
    { name: "build", testMatch: "build.spec.js" },
    { name: "empty-lake", testMatch: "overview.spec.js" },
    {
      name: "lake",
      testMatch: "export.spec.js",
      dependencies: ["empty-lake"],
    },
  ],
  use: {
    baseURL: INSIGHTS_AWS_URLS.admin,
    headless: true,
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  },
  webServer: [
    {
      // Only what these specs use: no SF311 fake, duplicate worker or analyzer.
      command:
        '../node_modules/.bin/concurrently -k -n svc,api,worker "npm:local:services" "npm:local:api" "npm:local:worker"',
      cwd: "../backend",
      url: `${INSIGHTS_AWS_URLS.api}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${vite} build --outDir ${dist} --logLevel warn && ${vite} preview --outDir ${dist} --host 127.0.0.1 --port ${INSIGHTS_AWS_PORTS.admin} --strictPort`,
      url: INSIGHTS_AWS_URLS.admin,
      reuseExistingServer: false,
    },
  ],
});
