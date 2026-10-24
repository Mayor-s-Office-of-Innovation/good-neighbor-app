import {
  GetCommand,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig, getDynamoTableName } from "../config.js";
import { supervisorOnly } from "../lib/admin-auth.js";
import { queryAllItems } from "../lib/query-all-items.js";
import { pacificToday, pacificDayStartIso } from "../lib/pacific-dates.js";
import { health } from "../domain/system-status.js";
import { presignGet } from "../s3.js";
import { jsonResponse } from "../http.js";

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
/** @param {Record<string, any>[]} keys */
async function batchGet(keys) {
  const table = getDynamoTableName();
  const rows = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (let attempt = 0; pending.length && attempt < 6; attempt++) {
      const result = await ddb.send(
        new BatchGetCommand({
          RequestItems: { [table]: { Keys: pending, ConsistentRead: true } },
        }),
      );
      rows.push(...(result.Responses?.[table] || []));
      pending = result.UnprocessedKeys?.[table]?.Keys || [];
      if (pending.length)
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
    if (pending.length) throw new Error("status_read_incomplete");
  }
  return rows;
}
/** @param {string} siteId @param {string} from @param {string} to */
async function events(siteId, from, to) {
  return (
    await queryAllItems({
      TableName: getDynamoTableName(),
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": `STATUS#${siteId}`,
        ":from": from,
        ":to": `${to}~`,
      },
    })
  ).Items;
}
/** @param {Record<string, any>} site @param {string} start @param {string} now */
async function summarize(site, start, now) {
  const rows = await events(site.siteId, start, now);
  const seenIssues = new Set();
  const today = rows.filter((row) => {
    if (row.kind === "issues") {
      if (seenIssues.has(row.issueId)) return false;
      seenIssues.add(row.issueId);
    }
    return row.at >= start;
  });
  const submissions = today.filter((row) => row.kind === "submissions");
  const analyses = await batchGet(
    submissions.map((row) => ({
      pk: `SITE#${site.siteId}`,
      sk: `CHECK#${row.checkId}#ANALYSIS#${row.artifactId}`,
    })),
  );
  const byArtifact = new Map(
    analyses.map((row) => [`${row.checkId}:${row.artifactId}`, row]),
  );
  const hours = Math.floor((Date.parse(now) - Date.parse(start)) / 3600000) + 1;
  const submissionHours = Array(hours).fill(0),
    successHours = Array(hours).fill(0),
    completeHours = Array(hours).fill(0);
  let succeeded = 0,
    failed = 0;
  for (const row of submissions) {
    const hour = Math.floor((Date.parse(row.at) - Date.parse(start)) / 3600000);
    submissionHours[hour]++;
    const state = byArtifact.get(`${row.checkId}:${row.artifactId}`)?.status;
    if (state === "analyzed") {
      succeeded++;
      successHours[hour]++;
      completeHours[hour]++;
    }
    if (state === "failed") {
      failed++;
      completeHours[hour]++;
    }
  }
  const counts = Object.fromEntries(
    [
      "submissions",
      "checks",
      "issues",
      "actions",
      "deletions",
      "duplicates",
    ].map((kind) => [kind, today.filter((row) => row.kind === kind).length]),
  );
  const groups = Object.fromEntries(
    ["issues", "actions", "deletions"].map((kind) => {
      /** @type {Record<string, number>} */ const grouped = {};
      for (const row of today.filter((row) => row.kind === kind))
        grouped[row.category] = (grouped[row.category] || 0) + 1;
      return [kind, grouped];
    }),
  );
  return {
    siteId: site.siteId,
    name: site.name,
    counts,
    groups,
    active: submissions.length > 0,
    submissionHours,
    analysisHours: completeHours.map((total, i) =>
      total ? (successHours[i] / total) * 100 : null,
    ),
    succeeded,
    failed,
    pending: submissions.length - succeeded - failed,
    analysis: health(succeeded, succeeded + failed, 90, 75),
    checks: {
      finished: today.filter(
        (row) => row.kind === "checks" && row.status === "completed",
      ).length,
      unfinished: today.filter(
        (row) => row.kind === "checks" && row.status !== "completed",
      ).length,
    },
  };
}

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getSystemStatus = (event) =>
  supervisorOnly(event, async () => {
    const now = new Date().toISOString(),
      start = pacificDayStartIso(pacificToday(new Date(now)));
    const readiness = await get({ pk: "SYSTEM#STATUS", sk: "#META" });
    if (!readiness?.ready)
      return jsonResponse(503, { error: "status_not_initialized" });
    const directory = (
      await queryAllItems({
        TableName: getDynamoTableName(),
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "STATUS_SITES" },
      })
    ).Items;
    const sites = [];
    // Bounded fan-out; all query pages are included before publishing any totals.
    for (let i = 0; i < directory.length; i += 5)
      sites.push(
        ...(await Promise.all(
          directory.slice(i, i + 5).map((site) => summarize(site, start, now)),
        )),
      );
    const succeeded = sites.reduce((n, s) => n + s.succeeded, 0),
      failed = sites.reduce((n, s) => n + s.failed, 0);
    return jsonResponse(200, {
      now,
      start,
      trackingSince: readiness.trackingSince,
      sites,
      network: health(
        sites.filter((s) => s.active).length,
        sites.length,
        75,
        25,
      ),
      analysis: health(succeeded, succeeded + failed, 90, 75),
      pending: sites.reduce((n, s) => n + s.pending, 0),
      duplicatesAvailable: process.env.DUPLICATE_DETECTION_ENABLED === "true",
    });
  });

/** @param {string} siteId @param {string} checkId @param {string} artifactId @param {boolean} [full] */
async function media(siteId, checkId, artifactId, full = false) {
  const artifact = await get({
    pk: `SITE#${siteId}`,
    sk: `CHECK#${checkId}#ART#${artifactId}`,
  });
  if (!artifact) return { unavailable: true };
  const key = full ? artifact.s3Key : artifact.thumbS3Key || artifact.s3Key;
  return {
    text: artifact.text || "",
    ...(key
      ? { url: await presignGet({ bucket: getConfig().uploadBucket, key }) }
      : {}),
    checkId,
    artifactId,
  };
}

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getStatusEntries = (event) =>
  supervisorOnly(event, async () => {
    const { siteId = "", kind = "" } = event.pathParameters || {};
    if (!["submissions", "duplicates"].includes(kind))
      return jsonResponse(400, { error: "invalid_kind" });
    if (!(await get({ pk: "STATUS_SITES", sk: siteId })))
      return jsonResponse(404, { error: "not_found" });
    const start = pacificDayStartIso(pacificToday()),
      now = new Date().toISOString();
    let cursor;
    try {
      const raw = event.queryStringParameters?.cursor;
      cursor = raw
        ? JSON.parse(Buffer.from(raw, "base64url").toString())
        : undefined;
      if (
        cursor &&
        (cursor.pk !== `STATUS#${siteId}` ||
          typeof cursor.sk !== "string" ||
          cursor.sk < start ||
          cursor.sk > `${now}~`)
      )
        throw new Error();
    } catch {
      return jsonResponse(400, { error: "invalid_cursor" });
    }
    const page = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
        FilterExpression: "kind = :kind",
        ExpressionAttributeValues: {
          ":pk": `STATUS#${siteId}`,
          ":from": start,
          ":to": `${now}~`,
          ":kind": kind,
        },
        Limit: 30,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
      }),
    );
    const entries = [];
    for (const row of page.Items || []) {
      if (kind === "submissions")
        entries.push({
          id: row.sk,
          at: row.at,
          ...(await media(siteId, row.checkId, row.artifactId)),
        });
      else
        entries.push({
          id: row.sk,
          at: row.at,
          taskId: row.taskId,
          eventKey: row.sk,
          originalTaskId: row.originalTaskId,
        });
    }
    return jsonResponse(200, {
      entries,
      cursor: page.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString(
            "base64url",
          )
        : null,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getStatusMedia = (event) =>
  supervisorOnly(event, async () => {
    const {
      siteId = "",
      checkId = "",
      artifactId = "",
    } = event.pathParameters || {};
    return jsonResponse(200, await media(siteId, checkId, artifactId, true));
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getStatusDuplicate = (event) =>
  supervisorOnly(event, async () => {
    const { siteId = "", taskId = "" } = event.pathParameters || {};
    const eventKey = event.queryStringParameters?.entry || "";
    const snapshot = eventKey
      ? await get({ pk: `STATUS#${siteId}`, sk: eventKey })
      : null;
    if (
      !snapshot ||
      snapshot.kind !== "duplicates" ||
      snapshot.taskId !== taskId
    )
      return jsonResponse(404, { error: "not_found" });
    const task = await get({ pk: `SITE#${siteId}`, sk: `TASK#${taskId}` });
    const original = await get({
      pk: `SITE#${siteId}`,
      sk: `TASK#${snapshot.originalTaskId}`,
    });
    const checkId = snapshot.checkId || task?.checkId;
    const artifactId = snapshot.artifactId || task?.sourceArtifactIds?.[0];
    const conditionId = snapshot.conditionId || task?.conditionId;
    const [matchedCheck, matchedArtifact] = snapshot.matchedObservationId
      ? snapshot.matchedObservationId.split(":")
      : [original?.checkId, original?.sourceArtifactIds?.[0]];
    const separated = !!(await get({
      pk: `SITE#${siteId}`,
      sk: `DUP_OVERRIDE#${JSON.stringify([checkId, artifactId, conditionId])}`,
    }));
    const pair = await Promise.all(
      [
        [checkId, artifactId],
        [matchedCheck, matchedArtifact],
      ].map(([check, artifact]) =>
        check && artifact
          ? media(siteId, check, artifact, true)
          : { unavailable: true },
      ),
    );
    return jsonResponse(200, { pair, separated });
  });
