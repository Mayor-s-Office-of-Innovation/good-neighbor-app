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
import {
  artifactKey,
  checkArtifactPrefix,
  checkHeaderKey,
  conditionKey,
  sitePk,
  taskKey,
  taskUpdateMediaKey,
  taskUpdatePrefix,
} from "./keys.js";

const URL_SECONDS = 300;
// Insights drops these tasks from every Issue, so their photos don't belong.
const DEAD_STATUSES = new Set(["superseded", "deleted"]);

/** @typedef {{ artifactId: string, source: "check" | "update", takenAt: string | null, thumbnailUrl: string, url: string, urlExpiresAt: string }} Photo */
/** @typedef {{ source: "check" | "update", at: string | null, text: string }} Note */

/** @param {{ pk: string, sk: string }} key */
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

/**
 * @param {string} pk
 * @param {string} prefix
 */
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
 * @param {string} siteId
 * @param {string} checkId the Check the photo was uploaded under
 * @returns {Promise<Photo | null>}
 */
async function photo(item, source, siteId, checkId) {
  // Stored keys are untrusted: never sign a file outside this Site's Check.
  const folder = `checks/${siteId}/${checkId}/`;
  /** @param {unknown} key */
  const inFolder = (key) =>
    typeof key === "string" && key.startsWith(folder) ? key : undefined;
  const original = inFolder(item.s3Key);
  if (!original) {
    if (typeof item.s3Key === "string")
      console.error(
        JSON.stringify({ marker: "MediaTenantMismatch", siteId, checkId }),
      );
    return null;
  }
  // iPhone HEIC uploads get a JPEG copy, since most browsers can't show HEIC.
  const shown =
    source === "update" && item.displayS3Key === `${original}.display.jpg`
      ? item.displayS3Key
      : original;
  const bucket = getConfig().uploadBucket;
  const [url, thumbnailUrl] = await Promise.all(
    [shown, inFolder(item.thumbS3Key) ?? shown].map((key) =>
      presignGet({ bucket, key, expiresIn: URL_SECONDS }),
    ),
  );
  return {
    artifactId: String(item.artifactId ?? ""),
    source,
    takenAt: item.capturedAt ?? null,
    thumbnailUrl,
    url,
    urlExpiresAt: new Date(Date.now() + URL_SECONDS * 1000).toISOString(),
  };
}

/**
 * @param {Record<string, any>[]} artifacts ART# rows of one Check
 * @param {string} siteId
 * @param {string} checkId
 */
async function checkEvidence(artifacts, siteId, checkId) {
  const photos = await Promise.all(
    artifacts.map((a) => photo(a, "check", siteId, checkId)),
  );
  /** @type {Note[]} */
  const notes = artifacts
    .filter((a) => typeof a.text === "string" && !a.s3Key)
    .map((a) => ({ source: "check", at: a.capturedAt ?? null, text: a.text }));
  return { photos: photos.filter((p) => p !== null), notes };
}

/**
 * The Issue's first task, then its duplicates and follow-up tasks, so the
 * panel shows every response.
 * @param {string} siteId
 * @param {Record<string, any>} root
 * @returns {Promise<Record<string, any>[]>}
 */
async function issueTasks(siteId, root) {
  const pk = sitePk(siteId);
  const [links, overrides] = await Promise.all([
    under(pk, "DUP_LINK#"),
    under(pk, "DUP_OVERRIDE#"),
  ]);
  // Staff split these sightings back out, so they are their own Issues.
  const separated = new Set(overrides.map((o) => String(o.taskId)));
  /** @type {Map<string, string[]>} original task → its duplicates */
  const duplicates = new Map();
  for (const link of links) {
    const id = String(link.taskId);
    if (separated.has(id)) continue;
    const original = String(link.originalTaskId);
    const list = duplicates.get(original);
    if (list) list.push(id);
    else duplicates.set(original, [id]);
  }
  const members = [root];
  const seen = new Set([String(root.taskId)]);
  for (let wave = [root]; wave.length; ) {
    const conditions = await Promise.all(
      wave.map((t) =>
        t.assessmentId && t.conditionId
          ? get(conditionKey(siteId, t.assessmentId, t.conditionId))
          : undefined,
      ),
    );
    const next = [
      ...wave.flatMap((t) => duplicates.get(String(t.taskId)) ?? []),
      ...conditions.flatMap((c) => (c?.taskIds ?? []).map(String)),
    ].filter((id) => !seen.has(id) && seen.add(id));
    const tasks = await Promise.all(next.map((id) => get(taskKey(siteId, id))));
    wave = /** @type {Record<string, any>[]} */ (
      tasks.filter((t) => t !== undefined && !DEAD_STATUSES.has(t.status))
    );
    members.push(...wave);
  }
  return members;
}

/**
 * @param {string | null} a
 * @param {string | null} b
 */
const byTime = (a, b) => String(a ?? "").localeCompare(String(b ?? ""));

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getRecordPhotos = (event) =>
  supervisorOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const checkId = event.queryStringParameters?.checkId ?? "";
    const issueId = event.queryStringParameters?.issueId ?? "";
    if (!siteId || Boolean(checkId) === Boolean(issueId))
      return jsonResponse(400, { error: "check_or_issue_required" });
    const pk = sitePk(siteId);
    if (checkId) {
      const [header, artifacts] = await Promise.all([
        get(checkHeaderKey(siteId, checkId)),
        under(pk, checkArtifactPrefix(checkId)),
      ]);
      if (!header) return jsonResponse(404, { error: "check_not_found" });
      return jsonResponse(200, await checkEvidence(artifacts, siteId, checkId));
    }
    const task = await get(taskKey(siteId, issueId));
    if (!task) return jsonResponse(404, { error: "issue_not_found" });
    const members = await issueTasks(siteId, task);
    // Follow-up tasks share their first task's photo, so each shows once.
    const found = new Map(
      members.flatMap((m) =>
        (Array.isArray(m.sourceArtifactIds) ? m.sourceArtifactIds : []).map(
          (id) => [`${m.checkId}|${id}`, { checkId: String(m.checkId), id }],
        ),
      ),
    );
    const [sources, timelines] = await Promise.all([
      // The photos each sighting was found in, first task first.
      Promise.all(
        [...found.values()].map(async ({ checkId: from, id }) => {
          const row = await get(artifactKey(siteId, from, id));
          return checkEvidence(row ? [row] : [], siteId, from);
        }),
      ),
      Promise.all(
        members.map(async (m) => {
          const [updates, media] = await Promise.all([
            under(pk, taskUpdatePrefix(m.taskId)),
            under(pk, taskUpdateMediaKey(siteId, m.taskId, "").sk),
          ]);
          // Only photos a saved update names; an abandoned upload has none.
          const named = new Set(
            updates.flatMap((u) =>
              Array.isArray(u.photoKeys) ? u.photoKeys.map(String) : [],
            ),
          );
          const added = await Promise.all(
            media
              .filter((row) => named.has(String(row.artifactId)))
              .map((row) => photo(row, "update", siteId, String(m.checkId))),
          );
          return { updates, added };
        }),
      ),
    ]);
    /** @type {Note[]} */
    const notes = timelines.flatMap(({ updates }) =>
      updates.flatMap((u) =>
        [
          ...(Array.isArray(u.notes) ? u.notes : []),
          // Additional-action updates keep their explanation here.
          ...(typeof u.text === "string" && u.text ? [u.text] : []),
        ].map((text) => ({
          source: /** @type {const} */ ("update"),
          at: u.occurredAt ?? null,
          text: String(text),
        })),
      ),
    );
    return jsonResponse(200, {
      photos: [
        ...sources.flatMap((s) => s.photos),
        ...timelines
          .flatMap((t) => t.added)
          .filter((p) => p !== null)
          .sort((a, b) => byTime(a.takenAt, b.takenAt)),
      ],
      notes: [...sources.flatMap((s) => s.notes), ...notes].sort((a, b) =>
        byTime(a.at, b.at),
      ),
    });
  });
