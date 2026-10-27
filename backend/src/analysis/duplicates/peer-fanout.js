import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const LEASE_MS = 60_000;

/**
 * Serialize fanout for a revision without acknowledging unfinished work. A
 * separate durable completedAt survives comparison-result replacement. Expired
 * claims are recoverable; owner fencing prevents stale completion/release.
 * Sends remain at-least-once if a worker dies after sending but before completing.
 * @param {{ddb:Pick<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,"send">,table:string,key:{pk:string,sk:string},work:(assertLease:()=>void)=>Promise<void>}} options
 * @returns {Promise<void>}
 */
export async function peerFanout({ ddb, table, key, work }) {
  const owner = randomUUID();
  const now = Date.now();
  const leaseUntil = now + LEASE_MS;
  const names = { "#owner": "owner" };
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: { ...key, owner, leaseUntil },
        ConditionExpression:
          "attribute_not_exists(completedAt) AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)",
        ExpressionAttributeValues: {
          ":now": now,
        },
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "ConditionalCheckFailedException"
    )
      throw error;
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    );
    if (Item?.completedAt) return;
    throw new Error("Peer fanout already claimed; retry unfinished work");
  }
  const assertLease = () => {
    if (Date.now() >= leaseUntil) throw new Error("Peer fanout lease expired");
  };
  try {
    // A delayed claim acknowledgement does not grant permission to send.
    assertLease();
    await work(assertLease);
    assertLease();
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: { ...key, completedAt: new Date().toISOString() },
        ConditionExpression: "#owner = :owner AND leaseUntil > :now",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ":owner": owner,
          ":now": Date.now(),
        },
      }),
    );
  } catch (error) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: key,
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (releaseError) {
      // Leave an unavailable store to recover via expiry. Never clear a newer
      // owner's claim, and preserve the original work/completion failure.
      if (
        !(releaseError instanceof Error) ||
        releaseError.name !== "ConditionalCheckFailedException"
      ) {
        throw new AggregateError(
          [error, releaseError],
          "Peer fanout failed and claim release failed",
        );
      }
    }
    throw error;
  }
}
