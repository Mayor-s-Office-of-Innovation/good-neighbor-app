import { queryAllItems } from "../src/lib/query-all-items.js";
import { summarize311Recovery } from "../src/domain/sf311-recovery-report.js";

// Explicit site scope; this command contains no writes, queue reads or City calls.
const args = process.argv.slice(2);
const sites = new Map();
for (let i = 0; i < args.length; i += 2) {
  const option = args[i],
    site = args[i + 1];
  if (
    !["--site", "--test-site"].includes(option) ||
    !site ||
    !/^[a-z0-9-]+$/.test(site)
  ) {
    throw new Error(
      "Usage: report-sf311-recovery.mjs --site <id> [--test-site <id>] ...",
    );
  }
  sites.set(site, option === "--test-site");
}
if (!process.env.DYNAMO_TABLE || !sites.size)
  throw new Error(
    "DYNAMO_TABLE and at least one explicit --site or --test-site are required",
  );
const reports = [];
for (const [siteId, testSite] of sites) {
  const items = [];
  for (const prefix of ["TASK#", "SF311_JOB#"]) {
    const page = await queryAllItems({
      TableName: process.env.DYNAMO_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `SITE#${siteId}`, ":prefix": prefix },
      ProjectionExpression:
        "sk, taskId, #status, appActions, appActionResults, results, silent311Snapshot",
      ExpressionAttributeNames: { "#status": "status" },
      ConsistentRead: true,
    });
    items.push(...page.Items);
  }
  reports.push({ siteId, testSite, ...summarize311Recovery(items) });
}
console.log(
  JSON.stringify(
    { readAt: new Date().toISOString(), mode: "read-only", reports },
    null,
    2,
  ),
);
