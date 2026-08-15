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
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  CreateQueueCommand,
  ListQueuesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

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

  return { tableName, queueUrl };
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 */
async function seedLocalSiteCodes(docDdb, tableName) {
  const now = new Date().toISOString();
  const items = [
    {
      pk: "SITE_CODE#123456",
      sk: "#META",
      type: "providerSiteCode",
      code: "123456",
      active: true,
      providerSiteId: "provider-site-health-center-mission",
      siteId: "site-health-center-mission",
      siteName: "Health Center Mission",
      seededAt: now,
    },
    {
      pk: "SITE_CODE#000000",
      sk: "#META",
      type: "providerSiteCode",
      code: "000000",
      active: false,
      providerSiteId: "provider-site-inactive",
      siteId: "site-inactive",
      siteName: "Inactive Test Site",
      seededAt: now,
    },
  ];

  for (const Item of items) {
    await docDdb.send(
      new PutCommand({
        TableName: tableName,
        Item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    ).catch((err) => {
      if (/** @type {Error} */ (err).name !== "ConditionalCheckFailedException") {
        throw err;
      }
    });
  }
}
