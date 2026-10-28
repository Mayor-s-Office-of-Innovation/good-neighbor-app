// Remove obsolete local sample-letter fixtures, retaining real history and PDFs.
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { getDynamoTableName } from "../src/config.js";
import { projectSiteCompliance } from "../src/lib/site-compliance.js";
import { devSiteCodeSeeds } from "./lib/site-code-seeds.mjs";

/** @param {{apply?: boolean, client?: typeof ddb, siteIds?: string[]}} [options] */
export async function reconcileLocalCompliance({
  apply = false,
  client = ddb,
  siteIds = devSiteCodeSeeds.map((site) => site.siteId),
} = {}) {
  const endpoint = new URL(
    process.env.AWS_ENDPOINT_URL_DYNAMODB || "https://not-local.invalid",
  );
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.protocol !== "http:"
  )
    throw new Error("Local DynamoDB endpoint required");
  const TableName = getDynamoTableName();
  let changed = 0,
    samplesRemoved = 0;
  for (const siteId of siteIds) {
    const Key = { pk: `SITE#${siteId}`, sk: "#META" };
    const { Item: site } = await client.send(
      new GetCommand({ TableName, Key, ConsistentRead: true }),
    );
    if (!site) continue;
    const periods = [];
    let cursor;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": Key.pk,
            ":prefix": "COMPLIANCE_TERMS#",
          },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      periods.push(...(page.Items || []));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    const isSample = (letter) =>
      !letter?.termsVersionId &&
      !letter?.s3Key &&
      letter?.url === "/sample-compliance-letter.pdf";
    const oldLetters = site.complianceLetters || { current: null, past: [] };
    const removed = [oldLetters.current, ...(oldLetters.past || [])].filter(
      isSample,
    ).length;
    const letters = {
      current: isSample(oldLetters.current) ? null : oldLetters.current || null,
      past: (oldLetters.past || []).filter((letter) => !isSample(letter)),
    };
    const canonical = projectSiteCompliance(site, periods);
    // Unknown real artifact metadata is retained; the API only displays artifacts
    // associated with canonical periods. Never manufacture periods from snapshots.
    if (
      !removed &&
      isDeepStrictEqual(site.compliance || {}, canonical.compliance)
    )
      continue;
    changed++;
    samplesRemoved += removed;
    if (!apply) continue;
    const conditions = ["attribute_exists(pk)"];
    const values = {
      ":compliance": canonical.compliance,
      ":letters": letters,
      ":now": new Date().toISOString(),
    };
    for (const [field, value] of Object.entries({
      updatedAt: site.updatedAt,
      compliance: site.compliance,
      complianceLetters: site.complianceLetters,
    })) {
      if (value === undefined)
        conditions.push(`attribute_not_exists(${field})`);
      else {
        conditions.push(`${field} = :observed_${field}`);
        values[`:observed_${field}`] = value;
      }
    }
    await client.send(
      new UpdateCommand({
        TableName,
        Key,
        UpdateExpression:
          "SET compliance = :compliance, complianceLetters = :letters, updatedAt = :now",
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeValues: values,
      }),
    );
  }
  return {
    mode: apply ? "apply" : "dry-run",
    sitesChanged: changed,
    sampleLettersRemoved: samplesRemoved,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(
    JSON.stringify(
      await reconcileLocalCompliance({
        apply: process.argv.includes("--apply"),
      }),
    ),
  );
