import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const tableName = process.env.DYNAMO_TABLE;
const apply = process.argv.includes("--apply");

if (!tableName) {
  console.error("[program-backfill] missing DYNAMO_TABLE");
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

run()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error("[program-backfill] failed", error);
    process.exit(1);
  });

async function run() {
  const sites = await scanSitesWithoutPrograms();
  const providers = new Map();
  const conflicts = [];
  for (const site of sites) {
    const providerId = String(site.providerId ?? "");
    if (!providerId) {
      conflicts.push({ siteId: site.siteId, reason: "provider_missing" });
      continue;
    }
    if (!providers.has(providerId)) {
      const result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
          ConsistentRead: true,
        }),
      );
      if (!result.Item || result.Item.status === "inactive") {
        conflicts.push({
          siteId: site.siteId,
          providerId,
          reason: "active_provider_not_found",
        });
        continue;
      }
      providers.set(providerId, result.Item);
    }
  }

  const eligible = sites.filter(
    (site) =>
      site.providerId &&
      providers.has(String(site.providerId)) &&
      !conflicts.some((conflict) => conflict.siteId === site.siteId),
  );
  const proposal = eligible.map((site) => ({
    siteId: site.siteId,
    siteName: site.name,
    providerId: site.providerId,
    programId: transitionalProgramId(String(site.providerId)),
  }));
  if (!apply) {
    return { mode: "dry-run", proposed: proposal, conflicts };
  }

  const runId = `program-backfill-${new Date().toISOString()}`;
  for (const [providerId, provider] of providers) {
    await ensureTransitionalProgram(providerId, String(provider.name), runId);
  }
  const applied = [];
  for (const site of eligible) {
    const programId = transitionalProgramId(String(site.providerId));
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk: `SITE#${site.siteId}`, sk: "#META" },
                UpdateExpression:
                  "SET leadProgramId = :programId, programName = :programName, programMigrationRunId = :runId, updatedAt = :now",
                ConditionExpression:
                  "attribute_exists(pk) AND attribute_not_exists(leadProgramId) AND providerId = :providerId",
                ExpressionAttributeValues: {
                  ":programId": programId,
                  ":programName": `Unassigned — ${providers.get(String(site.providerId)).name}`,
                  ":runId": runId,
                  ":now": new Date().toISOString(),
                  ":providerId": site.providerId,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: `PROGRAM#${programId}`,
                  sk: `SITE#${site.siteId}`,
                  type: "programSiteMembership",
                  programId,
                  siteId: site.siteId,
                  siteName: site.name,
                  status: "active",
                  migrationRunId: runId,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      applied.push(site.siteId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        conflicts.push({
          siteId: site.siteId,
          reason: "changed_since_preview",
        });
        continue;
      }
      throw error;
    }
  }
  return { mode: "apply", runId, applied, conflicts };
}

async function scanSitesWithoutPrograms() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
        FilterExpression:
          "#sk = :meta AND (entityType = :site OR #type = :siteType) AND #status = :active AND attribute_not_exists(leadProgramId)",
        ExpressionAttributeNames: {
          "#sk": "sk",
          "#status": "status",
          "#type": "type",
        },
        ExpressionAttributeValues: {
          ":meta": "#META",
          ":site": "SITE",
          ":siteType": "site",
          ":active": "active",
        },
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function ensureTransitionalProgram(providerId, providerName, runId) {
  const programId = transitionalProgramId(providerId);
  const name = `Unassigned — ${providerName}`;
  const now = new Date().toISOString();
  const key = { pk: `PROGRAM#${programId}`, sk: "#META" };
  const existing = await ddb.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  if (existing.Item) {
    if (
      existing.Item.providerId !== providerId ||
      existing.Item.migrationPlaceholder !== true
    ) {
      throw new Error(`program_id_conflict:${programId}`);
    }
    return;
  }
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              ...key,
              type: "program",
              entityType: "PROGRAM",
              programId,
              name,
              providerId,
              providerName,
              status: "active",
              migrationPlaceholder: true,
              needsReview: true,
              migrationRunId: runId,
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `PROVIDER#${providerId}`,
              sk: `PROGRAM#${programId}`,
              type: "providerProgramMembership",
              providerId,
              programId,
              programName: name,
              status: "active",
              migrationRunId: runId,
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: "PROGRAM_SEARCH#ACTIVE",
              sk: `${name.toLocaleLowerCase("en-US")}#${programId}`,
              type: "programSearch",
              programId,
              name,
              providerId,
              providerName,
              migrationPlaceholder: true,
              needsReview: true,
              updatedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }),
  );
}

function transitionalProgramId(providerId) {
  const safe = providerId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `migration-unassigned-${safe}`;
}
