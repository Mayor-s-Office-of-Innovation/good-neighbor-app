import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";

/**
 * Resolve a device bound to this Site, preserving dashboard attribution.
 * @param {Record<string, any>} site
 * @param {string} siteId
 * @returns {Promise<Record<string, string>>} Attribution fields for the dashboard.
 */
export async function perimeterAttribution(site, siteId) {
  if (!site.perimeterUpdatedBy || site.perimeterUpdatedSource === "dashboard")
    return {};
  const { Item: device } = await ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${site.perimeterUpdatedBy}` },
      ConsistentRead: true,
    }),
  );
  return device || site.perimeterUpdatedSource === "good-neighbor"
    ? {
        perimeterUpdatedSource: "good-neighbor",
        perimeterUpdatedDeviceLabel: device?.label || "",
      }
    : {};
}
