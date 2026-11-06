// Photos and notes behind one Check or Issue, for Insights' record panels.
// Read from the live table, since Insights' snapshot keeps no photos or free
// text; supervisors only, as for the admin's other photo route.

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig, getDynamoTableName } from "../config.js";
import { supervisorOnly } from "../lib/admin-auth.js";
import { queryAllItems } from "../lib/query-all-items.js";
import { presignGet } from "../s3.js";
import { jsonResponse } from "../http.js";

const URL_SECONDS = 300;

/** @typedef {{ artifactId: string, source: "check" | "update", takenAt: string | null, thumbnailUrl: string, url: string, urlExpiresAt: string }} Photo */
/** @typedef {{ source: "check" | "update", at: string | null, text: string }} Note */

/** @param {Record<string, any>} key */
async function get(key) {
  return (
    await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: key,
        ConsistentRead: true,
      }),
    )
  ).Item;
}

/** @param {string} pk @param {string} prefix */
async function under(pk, prefix) {
  return (
    await queryAllItems({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
    })
  ).Items;
}

/**
 * @param {Record<string, any>} item an ART# or MEDIA# row
 * @param {"check" | "update"} source
 * @returns {Promise<Photo | null>}
 */
async function photo(item, source) {
  if (typeof item.s3Key !== "string" || !item.s3Key) return null;
  const bucket = getConfig().uploadBucket;
  const [url, thumbnailUrl] = await Promise.all([
    presignGet({ bucket, key: item.s3Key, expiresIn: URL_SECONDS }),
    presignGet({
      bucket,
      key: item.thumbS3Key || item.s3Key,
      expiresIn: URL_SECONDS,
    }),
  ]);
  return {
    artifactId: String(item.artifactId ?? ""),
    source,
    takenAt: item.capturedAt ?? null,
    thumbnailUrl,
    url,
    urlExpiresAt: new Date(Date.now() + URL_SECONDS * 1000).toISOString(),
  };
}

/** @param {Record<string, any>[]} artifacts ART# rows */
async function checkEvidence(artifacts) {
  const photos = await Promise.all(artifacts.map((a) => photo(a, "check")));
  /** @type {Note[]} */
  const notes = artifacts
    .filter((a) => typeof a.text === "string" && !a.s3Key)
    .map((a) => ({ source: "check", at: a.capturedAt ?? null, text: a.text }));
  return { photos: photos.filter((p) => p !== null), notes };
}

/** @param {string | null} a @param {string | null} b */
const byTime = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getRecordPhotos = (event) =>
  supervisorOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const checkId = event.queryStringParameters?.checkId ?? "";
    const issueId = event.queryStringParameters?.issueId ?? "";
    if (!siteId || Boolean(checkId) === Boolean(issueId))
      return jsonResponse(400, { error: "check_or_issue_required" });
    const pk = `SITE#${siteId}`;
    if (checkId)
      return jsonResponse(
        200,
        await checkEvidence(await under(pk, `CHECK#${checkId}#ART#`)),
      );
    const task = await get({ pk, sk: `TASK#${issueId}` });
    if (!task) return jsonResponse(404, { error: "issue_not_found" });
    // The photo the Issue was found in, then what staff added later.
    const sources = await Promise.all(
      (Array.isArray(task.sourceArtifactIds) ? task.sourceArtifactIds : []).map(
        (artifactId) =>
          get({ pk, sk: `CHECK#${task.checkId}#ART#${artifactId}` }),
      ),
    );
    const found = await checkEvidence(
      /** @type {Record<string, any>[]} */ (sources.filter(Boolean)),
    );
    const updates = await under(pk, `TASK#${issueId}#UPDATE#`);
    const added = await Promise.all(
      updates.flatMap((u) =>
        (Array.isArray(u.photoKeys) ? u.photoKeys : []).map(async (id) => {
          const media = await get({ pk, sk: `TASK#${issueId}#MEDIA#${id}` });
          return media ? photo(media, "update") : null;
        }),
      ),
    );
    /** @type {Note[]} */
    const notes = updates.flatMap((u) =>
      (Array.isArray(u.notes) ? u.notes : []).map((text) => ({
        source: /** @type {const} */ ("update"),
        at: u.occurredAt ?? null,
        text: String(text),
      })),
    );
    return jsonResponse(200, {
      photos: [
        ...found.photos,
        ...added
          .filter((p) => p !== null)
          .sort((a, b) => byTime(a.takenAt, b.takenAt)),
      ],
      notes: [...found.notes, ...notes].sort((a, b) => byTime(a.at, b.at)),
    });
  });
