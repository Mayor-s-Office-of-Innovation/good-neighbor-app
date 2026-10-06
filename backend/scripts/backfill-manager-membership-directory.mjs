import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const tableName = process.env.DYNAMO_TABLE;
const apply = process.argv.includes("--apply");

if (!tableName) {
  console.error("[manager-directory-backfill] missing DYNAMO_TABLE");
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

run()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error("[manager-directory-backfill] failed", error);
    process.exit(1);
  });

async function run() {
  const sites = await listActiveSites();
  const memberships = [];
  for (const site of sites) {
    memberships.push(...(await listActiveMemberships(String(site.siteId))));
  }

  const proposed = memberships.map((membership) => ({
    siteId: membership.siteId,
    membershipId: membership.membershipId,
    emailHash: membership.emailHash,
  }));
  if (!apply) {
    return {
      mode: "dry-run",
      activeSites: sites.length,
      proposed,
      note: "No records were changed. Re-run with --apply after reviewing this output.",
    };
  }

  const applied = [];
  const unchanged = [];
  const conflicts = [];
  for (const membership of memberships) {
    const key = directoryKey(membership);
    const existing = await ddb.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    if (existing.Item) {
      if (
        existing.Item.siteId === membership.siteId &&
        existing.Item.membershipId === membership.membershipId
      ) {
        unchanged.push({
          siteId: membership.siteId,
          membershipId: membership.membershipId,
        });
      } else {
        conflicts.push({
          siteId: membership.siteId,
          membershipId: membership.membershipId,
          reason: "directory_key_conflict",
        });
      }
      continue;
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...key,
            type: "managerMembershipDirectory",
            membershipId: membership.membershipId,
            siteId: membership.siteId,
            status: "active",
            createdAt: membership.createdAt ?? new Date().toISOString(),
            migrationRunId: "manager-membership-directory-v1",
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      applied.push({
        siteId: membership.siteId,
        membershipId: membership.membershipId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        conflicts.push({
          siteId: membership.siteId,
          membershipId: membership.membershipId,
          reason: "changed_since_read",
        });
        continue;
      }
      throw error;
    }
  }
  return { mode: "apply", applied, unchanged, conflicts };
}

async function listActiveSites() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "SITE_SEARCH#ACTIVE" },
        ProjectionExpression: "siteId",
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.filter((item) => item.siteId);
}

async function listActiveMemberships(siteId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        FilterExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "MANAGER_MEMBERSHIP#",
          ":active": "active",
        },
        ProjectionExpression:
          "siteId, membershipId, emailHash, createdAt, #status",
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.filter(
    (item) => item.siteId && item.membershipId && item.emailHash,
  );
}

function directoryKey(membership) {
  return {
    pk: `MANAGER_EMAIL#${membership.emailHash}`,
    sk: `SITE#${membership.siteId}#MEMBERSHIP#${membership.membershipId}`,
  };
}
