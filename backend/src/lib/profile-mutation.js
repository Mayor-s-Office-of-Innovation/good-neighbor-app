import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminDeleteUserAttributesCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { jsonResponse } from "../http.js";

const NAME_ATTRIBUTES = ["given_name", "family_name", "name"];

/** Serialize profile writes and retain a recovery journal until both stores agree.
 * A lease outlasts Lambda's maximum invocation duration; a crashed invocation's
 * journal is recovered by the next profile request after the lease expires.
 * @param {string} subject
 * @param {{send(command: any): Promise<any>}} cognito
 * @param {(prepare: (journal: any) => Promise<void>) => Promise<any>} action
 */
export async function withProfileMutation(subject, cognito, action) {
  if (!subject) return jsonResponse(403, { error: "forbidden" });
  const Key = { pk: `ADMIN_PROFILE_LOCK#${subject}`, sk: "#LOCK" };
  const TableName = getDynamoTableName();
  const token = randomUUID();
  /** @type {any} */
  let journal;
  try {
    const previous = await ddb.send(
      new UpdateCommand({
        TableName,
        Key,
        UpdateExpression: "SET #token = :token, leaseUntil = :until",
        ConditionExpression: "attribute_not_exists(pk) OR leaseUntil < :now",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: {
          ":token": token,
          ":until": Date.now() + 960_000,
          ":now": Date.now(),
        },
        ReturnValues: "ALL_OLD",
      }),
    );
    journal = previous.Attributes?.recovery;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return jsonResponse(409, { error: "profile_change_in_progress" });
    }
    throw error;
  }
  const ownership = {
    ConditionExpression: "#token = :token",
    ExpressionAttributeNames: { "#token": "token" },
    ExpressionAttributeValues: { ":token": token },
  };
  const recover = async () => {
    if (!journal) return;
    // The directory is the commit point. A timed-out DynamoDB write might have
    // committed, so read it consistently instead of blindly restoring old names.
    let attrs = { ...journal.attributes };
    /** @type {string[]} */
    const attributeNames = journal.attributeNames || NAME_ATTRIBUTES;
    if (journal.directoryKey) {
      const result = await ddb.send(
        new GetCommand({
          TableName,
          Key: journal.directoryKey,
          ConsistentRead: true,
        }),
      );
      const directory = result.Item;
      if (
        directory &&
        (!directory.cognitoSubject || directory.cognitoSubject === subject)
      ) {
        attrs = {
          given_name: directory.firstName ?? attrs.given_name,
          family_name: directory.lastName ?? attrs.family_name,
          name: directory.name ?? attrs.name,
          ...(attributeNames.includes("phone_number")
            ? {
                phone_number: directory.phone
                  ? `+1${String(directory.phone).replace(/\D/g, "").slice(-10)}`
                  : attrs.phone_number,
              }
            : {}),
        };
      }
    }
    const identity = { UserPoolId: journal.pool, Username: journal.username };
    const user = await cognito.send(new AdminGetUserCommand(identity));
    if (
      !user.UserAttributes?.some(
        (/** @type {{ Name?: string, Value?: string }} */ attribute) =>
          attribute.Name === "sub" && attribute.Value === subject,
      )
    ) {
      throw new Error("profile_recovery_identity_mismatch");
    }
    const present = attributeNames.filter((key) => attrs[key] !== undefined);
    if (present.length)
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          ...identity,
          UserAttributes: present.map((Name) => ({ Name, Value: attrs[Name] })),
        }),
      );
    const absent = attributeNames.filter((key) => attrs[key] === undefined);
    if (absent.length)
      await cognito.send(
        new AdminDeleteUserAttributesCommand({
          ...identity,
          UserAttributeNames: absent,
        }),
      );
  };
  try {
    await recover();
    return await action(async (nextJournal) => {
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key,
          ...ownership,
          UpdateExpression: "SET recovery = :recovery",
          ExpressionAttributeValues: {
            ...ownership.ExpressionAttributeValues,
            ":recovery": nextJournal,
          },
        }),
      );
      journal = nextJournal;
    });
  } catch (error) {
    try {
      await recover();
    } catch {
      // Keep the journal for a subsequent GET/PUT to retry, without retaining
      // an active lease. Never delete recovery evidence after failed repair.
      journal = null;
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key,
          ...ownership,
          UpdateExpression: "SET leaseUntil = :expired",
          ExpressionAttributeValues: {
            ...ownership.ExpressionAttributeValues,
            ":expired": 0,
          },
        }),
      );
      return jsonResponse(503, { error: "profile_recovery_pending" });
    }
    throw error;
  } finally {
    // null marks a retained recovery journal; undefined means no write began.
    if (journal !== null)
      await ddb.send(new DeleteCommand({ TableName, Key, ...ownership }));
  }
}
