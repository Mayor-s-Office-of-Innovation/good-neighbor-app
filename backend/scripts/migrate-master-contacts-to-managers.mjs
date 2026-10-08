import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const tableName = process.env.DYNAMO_TABLE;
const apply = process.argv.includes("--apply");
if (!tableName) throw new Error("DYNAMO_TABLE is required");
if (apply && process.env.ENVIRONMENT !== "dev") {
  throw new Error("--apply is restricted to ENVIRONMENT=dev");
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const report = {
  mode: apply ? "apply" : "dry-run",
  converted: [],
  unchanged: [],
  conflicts: [],
};
let ExclusiveStartKey;
do {
  const page = await ddb.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "begins_with(sk, :prefix) AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":prefix": "MASTER_CONTACT#",
        ":active": "active",
      },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }),
  );
  for (const contact of page.Items ?? []) await migrate(contact);
  ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(JSON.stringify(report, null, 2));

async function migrate(contact) {
  const siteId = String(
    contact.siteId ?? String(contact.pk).replace(/^SITE#/, ""),
  );
  const email = String(contact.email ?? "")
    .trim()
    .toLowerCase();
  const emailHash = String(contact.emailHash ?? "");
  const site = (
    await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    )
  ).Item;
  if (
    !site ||
    site.status === "inactive" ||
    !site.leadProgramId ||
    !email ||
    !emailHash
  ) {
    report.conflicts.push({
      siteId,
      email,
      reason: !site
        ? "site_missing"
        : site.status === "inactive"
          ? "site_inactive"
          : !site.leadProgramId
            ? "lead_program_missing"
            : "contact_invalid",
    });
    return;
  }
  const markerKey = { pk: `SITE#${siteId}`, sk: `MANAGER_EMAIL#${emailHash}` };
  const existing = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: markerKey,
      ConsistentRead: true,
    }),
  );
  if (existing.Item) {
    report.unchanged.push({
      siteId,
      email,
      membershipId: existing.Item.membershipId,
    });
    return;
  }
  const membershipId = randomUUID();
  const now = new Date().toISOString();
  const summary = {
    siteId,
    email,
    membershipId,
    programId: site.leadProgramId,
  };
  if (!apply) {
    report.converted.push(summary);
    return;
  }
  const membership = {
    pk: `SITE#${siteId}`,
    sk: `MANAGER_MEMBERSHIP#${membershipId}`,
    type: "managerMembership",
    entityType: "MANAGER_MEMBERSHIP",
    membershipId,
    siteId,
    programId: site.leadProgramId,
    name: String(contact.name ?? email),
    email,
    emailHash,
    role: "manager",
    status: "active",
    generation: 1,
    createdAt: now,
    createdBy: "master-contact-migration-v1",
    updatedAt: now,
    updatedBy: "master-contact-migration-v1",
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(membership),
          put({
            ...markerKey,
            type: "managerMembershipEmail",
            membershipId,
            siteId,
            createdAt: now,
          }),
          put({
            pk: `MANAGER_EMAIL#${emailHash}`,
            sk: `SITE#${siteId}#MEMBERSHIP#${membershipId}`,
            type: "managerMembershipDirectory",
            membershipId,
            siteId,
            status: "active",
            createdAt: now,
          }),
          {
            Update: {
              TableName: tableName,
              Key: { pk: contact.pk, sk: contact.sk },
              UpdateExpression:
                "SET #status = :migrated, migratedToMembershipId = :membershipId, updatedAt = :now",
              ConditionExpression: "#status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ":migrated": "migrated",
                ":membershipId": membershipId,
                ":now": now,
              },
            },
          },
        ],
      }),
    );
    report.converted.push(summary);
  } catch (error) {
    report.conflicts.push({
      siteId,
      email,
      reason: error instanceof Error ? error.name : "migration_failed",
    });
  }
}

function put(Item) {
  return {
    Put: {
      TableName: tableName,
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}
