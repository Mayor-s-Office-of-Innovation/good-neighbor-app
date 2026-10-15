// One-time, site-scoped maintenance. Run before enabling the stream/queue mappings.
// Does not call analysis or Bedrock and does not infer resolution from tasks.
import {
  QueryCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ddb } from "../src/db.js";
import {
  analysisRevision,
  observationId,
  projectionKey,
} from "../src/analysis/duplicates/jobs.js";
import { LOOKBACK_MS } from "../src/analysis/duplicates/image-matcher.js";
const args = process.argv.slice(2);
const siteId = args.includes("--site")
  ? args[args.indexOf("--site") + 1]
  : undefined;
const table = process.env.DYNAMO_TABLE;
if (!siteId || !table || !process.env.DUPLICATE_QUEUE_URL)
  throw new Error(
    "Specify --site and configure DYNAMO_TABLE, DUPLICATE_QUEUE_URL, and AWS credentials",
  );
const startedAt = new Date();
const coverageFrom = new Date(startedAt.getTime() - LOOKBACK_MS).toISOString();
const pk = `SITE#${siteId}`;
const rows = [];
let cursor;
do {
  const page = await ddb.send(
    new QueryCommand({
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND begins_with(sk,:prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "CHECK#" },
      ExclusiveStartKey: cursor,
    }),
  );
  rows.push(...(page.Items ?? []));
  cursor = page.LastEvaluatedKey;
} while (cursor);
const byKey = new Map(rows.map((row) => [row.sk, row]));
const jobs = [];
for (const artifact of rows) {
  if (!artifact.sk.includes("#ART#")) continue;
  const a = byKey.get(artifact.sk.replace("#ART#", "#ANALYSIS#"));
  const observed = Date.parse(a?.generatedAt ?? a?.analyzedAt ?? "");
  if (
    !Number.isFinite(observed) ||
    observed < startedAt.getTime() - LOOKBACK_MS ||
    observed > startedAt.getTime()
  )
    continue;
  const [checkId, artifactId] = [
    artifact.sk.split("#")[1],
    artifact.sk.split("#")[3],
  ];
  const analysisKey = { pk, sk: `CHECK#${checkId}#ANALYSIS#${artifactId}` };
  const analysis = byKey.get(analysisKey.sk);
  if (
    analysis?.status !== "analyzed" ||
    !Number.isFinite(Date.parse(analysis.analyzedAt))
  )
    continue;
  const revision = analysisRevision(analysis);
  const id = observationId(checkId, artifactId);
  const key = projectionKey(
    siteId,
    analysis.generatedAt ?? analysis.analyzedAt,
    id,
  );
  const existing = (
    await ddb.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    )
  ).Item;
  if (!existing) {
    const projection = {
      ...key,
      id,
      siteId,
      sourceId: id,
      checkId,
      artifactId,
      revision,
      observedAt: new Date(observed).toISOString(),
      availableAt: analysis.analyzedAt,
      ...(artifact.s3Key
        ? { s3Key: artifact.s3Key, contentType: artifact.contentType }
        : {}),
      conditions: (analysis.concerns ?? [])
        .filter((c) => c.rating > 0 && c.conditionId)
        .map((c) => ({
          id: c.conditionId,
          category: c.category,
          description: c.explanation,
        })),
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: table,
              Key: analysisKey,
              ConditionExpression: "analysisId = :id AND concerns = :concerns",
              ExpressionAttributeValues: {
                ":id": analysis.analysisId,
                ":concerns": analysis.concerns,
              },
            },
          },
          {
            Put: {
              TableName: table,
              Item: projection,
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
        ],
      }),
    );
  }
  jobs.push({ siteId, checkId, artifactId, revision });
}
// Published only after the complete paginated partition read and projection writes.
await ddb.send(
  new PutCommand({
    TableName: table,
    Item: {
      pk,
      sk: "DUP_COVERAGE",
      coverageFrom,
      bootstrappedAt: startedAt.toISOString(),
    },
  }),
);
const sqs = new SQSClient({});
for (const job of jobs)
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.DUPLICATE_QUEUE_URL,
      MessageBody: JSON.stringify(job),
    }),
  );
console.info(
  `Bootstrapped ${jobs.length} observations; queued isolated duplicate evaluation. No media or descriptions logged.`,
);
