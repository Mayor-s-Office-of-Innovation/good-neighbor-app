import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";

/** @param {import("@aws-sdk/lib-dynamodb").QueryCommandInput} input */
export async function queryAllItems(input) {
  const Items = [];
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        ...input,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    Items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { Items };
}
