import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";

/** Build scoped roster projection changes for a linked manager membership.
 * @param {string} tableName @param {string} siteId @param {string} programId
 * @param {string} userId @param {boolean} adding @param {string} now
 */
export async function managerAssignmentChanges(
  tableName,
  siteId,
  programId,
  userId,
  adding,
  now,
) {
  if (!programId || !userId) return [];
  const [userResult, assignmentResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
        ConsistentRead: true,
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
        ConsistentRead: true,
      }),
    ),
  ]);
  const user = userResult.Item;
  const assignment = assignmentResult.Item;
  if (adding && (!user || user.status !== "active"))
    throw new Error("program_user_not_found");
  if (adding === Boolean(assignment)) return [];
  const count = Number(user?.siteAssignmentCount || 0);
  /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
  const changes = adding
    ? [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `SITE#${siteId}`,
              sk: `ASSIGNED_USER#${userId}`,
              type: "siteUserAssignment",
              siteId,
              programId,
              userId,
              firstName: user?.firstName,
              lastName: user?.lastName,
              email: user?.email,
              phone: user?.phone,
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ]
    : [
        {
          Delete: {
            TableName: tableName,
            Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
            ConditionExpression: "programId = :program",
            ExpressionAttributeValues: { ":program": programId },
          },
        },
      ];
  if (user)
    changes.push({
      Update: {
        TableName: tableName,
        Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
        UpdateExpression: "SET siteAssignmentCount = :next, updatedAt = :now",
        ConditionExpression: `attribute_exists(pk)${adding ? " AND #status = :active" : ""} AND ${user.siteAssignmentCount === undefined ? "attribute_not_exists(siteAssignmentCount)" : "siteAssignmentCount = :previous"}`,
        ...(adding
          ? { ExpressionAttributeNames: { "#status": "status" } }
          : {}),
        ExpressionAttributeValues: {
          ...(adding ? { ":active": "active" } : {}),
          ":next": adding ? count + 1 : Math.max(0, count - 1),
          ":now": now,
          ...(user.siteAssignmentCount === undefined
            ? {}
            : { ":previous": count }),
        },
      },
    });
  return changes;
}
