// Idempotent local "infra as code": creates the DynamoDB table and SQS queue the
// backend expects, against the local jars. This is the local analogue of
// `terraform apply` — the table shape is kept in lockstep with the Terraform
// `aws_dynamodb_table` (infra/modules/app/main.tf) so local and prod don't drift.
//
// Safe to call repeatedly: existing resources are treated as success. The API
// router and worker each call ensureLocalInfra() at startup, so a fresh
// `npm run dev` self-bootstraps without a separate ordered step, and re-runs are
// no-ops.

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CreateQueueCommand,
  ListQueuesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { seedSiteCodes } from "./site-code-seeds.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an operation until it stops throwing connection errors — absorbs JVM
 * warmup. Rethrows immediately on any non-connection error.
 * @param {() => Promise<unknown>} probe
 * @param {string} label
 */
async function waitForService(probe, label) {
  const attempts = 40;
  for (let i = 1; i <= attempts; i++) {
    try {
      await probe();
      return;
    } catch (err) {
      const code =
        /** @type {{ code?: string, name?: string }} */ (err).code ??
        /** @type {{ name?: string }} */ (err).name;
      const connreset =
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        code === "TimeoutError" ||
        /** @type {Error} */ (err).message?.includes("fetch failed");
      if (!connreset || i === attempts) {
        if (i === attempts) {
          throw new Error(
            `${label} not reachable after ${attempts} attempts: ${/** @type {Error} */ (err).message}`,
          );
        }
        throw err;
      }
      await sleep(250);
    }
  }
}

const TABLE_SCHEMA = {
  BillingMode: "PAY_PER_REQUEST", // matches Terraform; no ProvisionedThroughput anywhere
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    { AttributeName: "gsi1pk", AttributeType: "S" },
    { AttributeName: "gsi1sk", AttributeType: "S" },
    { AttributeName: "gsi2pk", AttributeType: "S" },
    { AttributeName: "gsi2sk", AttributeType: "S" },
    { AttributeName: "gsi4pk", AttributeType: "S" },
    { AttributeName: "gsi4sk", AttributeType: "S" },
    { AttributeName: "gsi5pk", AttributeType: "S" },
    { AttributeName: "gsi5sk", AttributeType: "S" },
    { AttributeName: "gsi6pk", AttributeType: "S" },
    { AttributeName: "gsi6sk", AttributeType: "S" },
    { AttributeName: "gsi7pk", AttributeType: "S" },
    { AttributeName: "gsi7sk", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "GSI1",
      KeySchema: [
        { AttributeName: "gsi1pk", KeyType: "HASH" },
        { AttributeName: "gsi1sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "GSI2",
      KeySchema: [
        { AttributeName: "gsi2pk", KeyType: "HASH" },
        { AttributeName: "gsi2sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "GSI4",
      KeySchema: [
        { AttributeName: "gsi4pk", KeyType: "HASH" },
        { AttributeName: "gsi4sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "GSI5",
      KeySchema: [
        { AttributeName: "gsi5pk", KeyType: "HASH" },
        { AttributeName: "gsi5sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "GSI6",
      KeySchema: [
        { AttributeName: "gsi6pk", KeyType: "HASH" },
        { AttributeName: "gsi6sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "GSI7",
      KeySchema: [
        { AttributeName: "gsi7pk", KeyType: "HASH" },
        { AttributeName: "gsi7sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
};

/**
 * Create the table + queue if absent. Reads endpoint/name from the environment
 * (loaded via --env-file). Returns the resolved queue URL.
 * @returns {Promise<{ tableName: string, queueUrl: string }>}
 */
export async function ensureLocalInfra() {
  const tableName = process.env.DYNAMO_TABLE;
  const queueUrl = process.env.SQS_QUEUE_URL;
  const uploadBucket = process.env.S3_UPLOAD_BUCKET;
  if (!tableName) throw new Error("DYNAMO_TABLE is not set");
  if (!queueUrl) throw new Error("SQS_QUEUE_URL is not set");

  const ddb = new DynamoDBClient({});
  const docDdb = DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sqs = new SQSClient({});

  // DynamoDB: wait for reachability, then create-if-absent.
  await waitForService(
    () => ddb.send(new DescribeTableCommand({ TableName: tableName })),
    "DynamoDB Local",
  ).catch((err) => {
    // DescribeTable throwing ResourceNotFound still means the service is up.
    if (/** @type {Error} */ (err).name !== "ResourceNotFoundException")
      throw err;
  });

  try {
    await ddb.send(
      new CreateTableCommand({ TableName: tableName, ...TABLE_SCHEMA }),
    );
    console.log(`[bootstrap] created DynamoDB table "${tableName}"`);
  } catch (err) {
    if (/** @type {Error} */ (err).name === "ResourceInUseException") {
      console.log(`[bootstrap] DynamoDB table "${tableName}" already exists`);
    } else {
      throw err;
    }
  }

  await ensureLocalTableIndexes(ddb, tableName);
  await seedLocalSiteCodes(docDdb, tableName);

  // SQS: derive the queue name from the configured URL's last path segment.
  const queueName = queueUrl.split("/").filter(Boolean).pop();
  await waitForService(() => sqs.send(new ListQueuesCommand({})), "ElasticMQ");
  try {
    const res = await sqs.send(
      new CreateQueueCommand({ QueueName: queueName }),
    );
    console.log(
      `[bootstrap] created SQS queue "${queueName}" (${res.QueueUrl})`,
    );
  } catch (err) {
    const name = /** @type {Error} */ (err).name;
    if (
      name === "QueueNameExists" ||
      name === "QueueAlreadyExists" ||
      name === "QueueDeletedRecently"
    ) {
      console.log(`[bootstrap] SQS queue "${queueName}" already exists`);
    } else {
      throw err;
    }
  }

  // S3 (MinIO): only when the local S3 endpoint is set — otherwise the client
  // would point at real AWS and creating a bucket there is not what "local
  // bootstrap" means. Just an idempotent bucket create; CORS for the browser's
  // cross-origin presigned PUT is handled globally by MinIO's
  // MINIO_API_CORS_ALLOW_ORIGIN env var (set in local-minio.mjs), since MinIO
  // returns 501 NotImplemented for the per-bucket PutBucketCors API.
  if (process.env.AWS_ENDPOINT_URL_S3) {
    if (!uploadBucket) throw new Error("S3_UPLOAD_BUCKET is not set");
    const s3 = new S3Client({ forcePathStyle: true });

    await waitForService(
      () => s3.send(new HeadBucketCommand({ Bucket: uploadBucket })),
      "MinIO",
    ).catch((err) => {
      // A reachable MinIO answering 404/NoSuchBucket still means it's up.
      const name = /** @type {Error} */ (err).name;
      const status =
        /** @type {{ $metadata?: { httpStatusCode?: number } }} */ (err)
          .$metadata?.httpStatusCode;
      if (name !== "NotFound" && name !== "NoSuchBucket" && status !== 404) {
        throw err;
      }
    });

    try {
      await s3.send(new CreateBucketCommand({ Bucket: uploadBucket }));
      console.log(`[bootstrap] created S3 bucket "${uploadBucket}"`);
    } catch (err) {
      const name = /** @type {Error} */ (err).name;
      if (
        name === "BucketAlreadyOwnedByYou" ||
        name === "BucketAlreadyExists"
      ) {
        console.log(`[bootstrap] S3 bucket "${uploadBucket}" already exists`);
      } else {
        throw err;
      }
    }
  }

  return { tableName, queueUrl };
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 */
async function seedLocalSiteCodes(docDdb, tableName) {
  await seedSiteCodes(docDdb, tableName, {
    includeInactive: true,
    includeLegacyLocalCode: true,
  });
}

/**
 * DynamoDB Local keeps persisted tables between runs, so create-table changes
 * need a small reconciliation path for indexes added after a developer's first
 * bootstrap.
 * @param {DynamoDBClient} ddb
 * @param {string} tableName
 * @returns {Promise<void>}
 */
async function ensureLocalTableIndexes(ddb, tableName) {
  const description = await describeTable(ddb, tableName);
  const existing = new Set(
    description.Table?.GlobalSecondaryIndexes?.map((index) => index.IndexName),
  );
  const missing = (TABLE_SCHEMA.GlobalSecondaryIndexes ?? []).filter(
    (index) => !existing.has(index.IndexName),
  );

  for (const index of missing) {
    console.log(
      `[bootstrap] adding DynamoDB local index "${index.IndexName}" to "${tableName}"`,
    );
    await ddb.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: attributeDefinitionsForIndex(index),
        GlobalSecondaryIndexUpdates: [{ Create: index }],
      }),
    );
    await waitForIndex(ddb, tableName, index.IndexName);
  }
}

/**
 * @param {DynamoDBClient} ddb
 * @param {string} tableName
 * @returns {Promise<import("@aws-sdk/client-dynamodb").DescribeTableCommandOutput>}
 */
async function describeTable(ddb, tableName) {
  return ddb.send(new DescribeTableCommand({ TableName: tableName }));
}

/**
 * @param {import("@aws-sdk/client-dynamodb").GlobalSecondaryIndex} index
 * @returns {import("@aws-sdk/client-dynamodb").AttributeDefinition[]}
 */
function attributeDefinitionsForIndex(index) {
  const attributeNames = new Set(
    index.KeySchema?.map((key) => key.AttributeName).filter(Boolean),
  );
  return TABLE_SCHEMA.AttributeDefinitions.filter((attribute) =>
    attributeNames.has(attribute.AttributeName),
  );
}

/**
 * @param {DynamoDBClient} ddb
 * @param {string} tableName
 * @param {string | undefined} indexName
 * @returns {Promise<void>}
 */
async function waitForIndex(ddb, tableName, indexName) {
  const attempts = 80;
  for (let i = 1; i <= attempts; i += 1) {
    const description = await describeTable(ddb, tableName);
    const index = description.Table?.GlobalSecondaryIndexes?.find(
      (candidate) => candidate.IndexName === indexName,
    );
    if (index?.IndexStatus === "ACTIVE") return;
    await sleep(250);
  }
  throw new Error(
    `DynamoDB local index "${indexName}" on "${tableName}" was not active after ${attempts} attempts`,
  );
}
