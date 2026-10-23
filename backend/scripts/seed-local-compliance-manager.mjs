// Add the local role-switch identity without changing any existing Site assignments.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { assertLocalSeedTarget } from "./lib/site-admin-seed.mjs";
assertLocalSeedTarget();
const TableName = process.env.DYNAMO_TABLE;
const Key = {
  pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
  sk: "MANAGER#maya.manager@example.org",
};
const { Item } = await ddb.send(new GetCommand({ TableName, Key }));
if (!Item) {
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName,
      ConditionExpression: "attribute_not_exists(pk)",
      Item: {
        ...Key,
        type: "cityProgramManager",
        userId: "local-maya-manager",
        firstName: "Maya",
        lastName: "Manager",
        name: "Maya Manager",
        email: "maya.manager@example.org",
        phone: "4155550198",
        departmentName: "Department of Public Health (DPH)",
        status: "active",
        cognitoSubject: "maya.manager@example.org",
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}
console.log("Local Maya manager is ready; use Supervisor to assign Sites.");
