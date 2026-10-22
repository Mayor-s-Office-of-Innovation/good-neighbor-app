// Site-scoped recovery after the worker/IAM fix is deployed. Dry-run by default.
// Requeue current revisions only; never reset results, links, or human overrides.
import { parseArgs } from "node:util";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ddb } from "../src/db.js";
import { analysisRevision } from "../src/analysis/duplicates/jobs.js";
const { values } = parseArgs({
  options: {
    site: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const table = process.env.DYNAMO_TABLE,
  queue = process.env.DUPLICATE_QUEUE_URL;
if (!values.site || !table || (values.apply && !queue))
  throw new Error(
    "Specify --site, DYNAMO_TABLE, and (for --apply) DUPLICATE_QUEUE_URL",
  );
const sqs = new SQSClient({});
const pk = `SITE#${values.site}`;
let cursor,
  selected = 0,
  skipped = 0;
do {
  const page = await ddb.send(
    new QueryCommand({
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "DUP_RESULT#" },
      ExclusiveStartKey: cursor,
    }),
  );
  for (const result of page.Items ?? []) {
    if (
      !["pending", "failed"].includes(result.status) &&
      !result.conditionResults?.some(
        (c) => c.assessmentOutcome === "no_match_with_failures",
      )
    )
      continue;
    const [, id, revision] = result.sk.split("#");
    const [checkId, artifactId] = id.split(":");
    const analysis = (
      await ddb.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk: `CHECK#${checkId}#ANALYSIS#${artifactId}` },
          ConsistentRead: true,
        }),
      )
    ).Item;
    const time = Date.parse(
      analysis?.generatedAt ?? analysis?.analyzedAt ?? "",
    );
    // Old revisions cannot be recovered and expired evidence must not be revived.
    if (
      !analysis ||
      analysis.status !== "analyzed" ||
      analysisRevision(analysis) !== revision ||
      !Number.isFinite(time) ||
      Date.now() - time >= 30 * 86400000
    ) {
      skipped++;
      continue;
    }
    const job = {
      siteId: values.site,
      checkId,
      artifactId,
      revision,
      enqueuedAt: new Date().toISOString(),
    };
    if (values.apply)
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: JSON.stringify(job),
        }),
      );
    selected++;
    console.log(
      JSON.stringify({
        ...job,
        action: values.apply ? "enqueued" : "would_enqueue",
      }),
    );
  }
  cursor = page.LastEvaluatedKey;
} while (cursor);
console.log(JSON.stringify({ selected, skipped, applied: values.apply }));
