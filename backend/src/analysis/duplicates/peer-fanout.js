import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const LEASE_MS = 60_000;

/**
 * Fanout advances a durable cursor in ascending peer-key order. Every successful
 * send checkpoints progress and renews the owned lease; retries skip that prefix.
 * Sends remain at-least-once across a crash between SQS and the checkpoint write.
 * @param {{ddb:Pick<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,"send">,table:string,key:{pk:string,sk:string},work:(assertLease:()=>void,sendPeer:(peerKey:string,send:()=>Promise<unknown>)=>Promise<void>)=>Promise<void>}} options
 * @returns {Promise<void>}
 */
export async function peerFanout({ ddb, table, key, work }) {
  const read = async () =>
    (
      await ddb.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
      )
    ).Item;
  const previous = await read();
  if (previous?.completedAt) return;
  const owner = randomUUID();
  let leaseUntil = Date.now() + LEASE_MS;
  let lastPeerKey = previous?.lastPeerKey;
  const names = { "#owner": "owner" };
  const cursorCondition =
    lastPeerKey === undefined
      ? "attribute_not_exists(lastPeerKey)"
      : "lastPeerKey = :cursor";
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...key,
          owner,
          leaseUntil,
          ...(lastPeerKey === undefined ? {} : { lastPeerKey }),
        },
        // Fence the cursor as well: a delayed claimant must not overwrite progress
        // made by another owner whose lease has since expired.
        ConditionExpression: `attribute_not_exists(completedAt) AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now) AND ${cursorCondition}`,
        ExpressionAttributeValues: {
          ":now": Date.now(),
          ...(lastPeerKey === undefined ? {} : { ":cursor": lastPeerKey }),
        },
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "ConditionalCheckFailedException"
    )
      throw error;
    if ((await read())?.completedAt) return;
    throw new Error(
      "Peer fanout already claimed or advanced; retry unfinished work",
    );
  }
  const assertLease = () => {
    if (Date.now() >= leaseUntil) throw new Error("Peer fanout lease expired");
  };
  /** @param {string|undefined} cursor */
  const checkpoint = async (cursor) => {
    assertLease();
    const renewedUntil = Date.now() + LEASE_MS;
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...key,
          owner,
          leaseUntil: renewedUntil,
          ...(cursor === undefined ? {} : { lastPeerKey: cursor }),
        },
        ConditionExpression: "#owner = :owner AND leaseUntil > :now",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":owner": owner, ":now": Date.now() },
      }),
    );
    lastPeerKey = cursor;
    leaseUntil = renewedUntil;
    assertLease();
  };
  try {
    assertLease();
    await work(assertLease, async (peerKey, send) => {
      if (lastPeerKey !== undefined && peerKey <= lastPeerKey) return;
      assertLease();
      // Refresh before a send when the current lease is close to expiry.
      if (leaseUntil - Date.now() < 20_000) await checkpoint(lastPeerKey);
      assertLease();
      await send();
      await checkpoint(peerKey);
    });
    assertLease();
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...key,
          completedAt: new Date().toISOString(),
          ...(lastPeerKey === undefined ? {} : { lastPeerKey }),
        },
        ConditionExpression: "#owner = :owner AND leaseUntil > :now",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":owner": owner, ":now": Date.now() },
      }),
    );
  } catch (error) {
    try {
      // Read back acknowledged OR ambiguously committed progress. Release must
      // neither erase a newer cursor nor clear a replacement owner's claim.
      const latest = await read();
      if (latest?.owner === owner) {
        const cursor = latest.lastPeerKey;
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              ...key,
              ...(cursor === undefined ? {} : { lastPeerKey: cursor }),
            },
            ConditionExpression: `#owner = :owner AND ${cursor === undefined ? "attribute_not_exists(lastPeerKey)" : "lastPeerKey = :cursor"}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: {
              ":owner": owner,
              ...(cursor === undefined ? {} : { ":cursor": cursor }),
            },
          }),
        );
      }
    } catch (releaseError) {
      if (
        !(releaseError instanceof Error) ||
        releaseError.name !== "ConditionalCheckFailedException"
      )
        throw new AggregateError(
          [error, releaseError],
          "Peer fanout failed and claim release failed",
        );
    }
    throw error;
  }
}
