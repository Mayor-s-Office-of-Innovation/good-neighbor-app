// Local-only, additive reporting fixtures. Run from backend with:
// node --env-file=../.env.local scripts/seed-local-reports.mjs <siteId>
// Stable IDs make reruns safe: existing items (including edited fixtures) are skipped.
import { putSeedPhoto } from "./lib/report-seed-photo.mjs";
import { readFile } from "node:fs/promises";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { ddb } from "../src/db.js";
import { assertLocalSeedTarget } from "./lib/site-admin-seed.mjs";
import {
  siteMetaKey,
  checkHeaderKey,
  checkTimelineGsi,
  artifactKey,
  taskKey,
  taskTimelineGsi,
  taskWorklistPk,
  taskUpdateKey,
  taskUpdateTimelineGsi,
} from "../src/handlers/keys.js";

assertLocalSeedTarget();
const siteId = process.argv[2];
if (!siteId) throw new Error("Pass the local siteId to seed.");
const TableName = process.env.DYNAMO_TABLE;
const Bucket = process.env.S3_UPLOAD_BUCKET;
if (!Bucket?.startsWith("gnp-local-"))
  throw new Error("Requires a local upload bucket.");
const site = await ddb.send(
  new GetCommand({ TableName, Key: siteMetaKey(siteId) }),
);
if (!site.Item) throw new Error("Local site does not exist.");
const seedId = "synthetic-reports-2026-10-v1";
const s3 = new S3Client({ forcePathStyle: true });
const photos = await Promise.all(
  [1, 2].map((n) =>
    readFile(
      new URL(`../../e2e/fixtures/photos/input-${n}.jpg`, import.meta.url),
    ),
  ),
);
const schedule = [
  ["2026-09-28", 1],
  ["2026-09-30", 2],
  ["2026-10-01", 1],
  ["2026-10-05", 3],
  ["2026-10-12", 2],
  ["2026-10-18", 1],
  ["2026-10-19", 3],
  ["2026-10-20", 1],
  ["2026-10-21", 2],
  ["2026-10-22", 3],
  ["2026-10-23", 1],
  ["2026-10-24", 2],
  ["2026-10-25", 3],
  ["2026-10-26", 1],
];
const times = ["09:04:00", "14:07:00", "19:02:00"];
const statuses = ["completed", "in_progress", "open", "cannot_do"];
const categories = ["Litter", "Graffiti", "Illegal dumping"];
const summary = {
  site: site.Item.name,
  checks: 0,
  photos: 0,
  issues: 0,
  inserted: 0,
  skipped: 0,
  octoberChecks: 0,
  octoberIssues: 0,
  octoberResolved: 0,
};
async function put(item) {
  try {
    await ddb.send(
      new PutCommand({
        TableName,
        Item: { ...item, seedId, synthetic: true },
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    summary.inserted++;
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    const existing = await ddb.send(
      new GetCommand({ TableName, Key: { pk: item.pk, sk: item.sk } }),
    );
    if (existing.Item?.seedId !== seedId)
      throw new Error(`Seed ID collision: ${item.sk}`);
    summary.skipped++;
  }
}
let index = 0;
for (const [date, count] of schedule) {
  for (let slot = 0; slot < count; slot++) {
    index++;
    const checkId = `synthetic-report-${date}-${slot + 1}`;
    const startedAt = new Date(`${date}T${times[slot]}-07:00`).toISOString();
    const completedAt = new Date(
      Date.parse(startedAt) + 5 * 60000,
    ).toISOString();
    const photoCount = slot === 0 ? 5 : 3;
    const issueCount = index % 5 === 0 ? 0 : 2;
    const artifacts = [];
    for (let n = 0; n < photoCount; n++) {
      const artifactId = `synthetic-photo-${n + 1}`;
      artifacts.push(artifactId);
      const s3Key = `checks/${siteId}/${checkId}/${artifactId}.jpg`;
      await putSeedPhoto(s3, {
        Bucket,
        Key: s3Key,
        Body: photos[n % photos.length],
        seedId,
      });
      await put({
        ...artifactKey(siteId, checkId, artifactId),
        artifactId,
        checkId,
        s3Key,
        contentType: "image/jpeg",
        contentLength: photos[n % photos.length].length,
        capturedAt: startedAt,
        createdAt: startedAt,
        uploadedAt: startedAt,
      });
    }
    for (let n = 0; n < issueCount; n++) {
      const taskId = `${checkId}-issue-${n + 1}`;
      const status =
        date === "2026-10-26"
          ? ["open", "in_progress"][n]
          : statuses[(index + n) % statuses.length];
      // September-created / October-completed issue verifies the cohort boundary.
      const resolvedAt =
        date === "2026-09-30"
          ? "2026-10-02T19:00:00.000Z"
          : new Date(Date.parse(startedAt) + 45 * 60000).toISOString();
      const updatedAt =
        status === "completed"
          ? resolvedAt
          : new Date(Date.parse(startedAt) + 15 * 60000).toISOString();
      const task = {
        ...taskKey(siteId, taskId),
        ...taskTimelineGsi(siteId, startedAt, taskId),
        gsi2pk: taskWorklistPk(siteId, status),
        gsi2sk: `${startedAt}#${taskId}`,
        taskId,
        checkId,
        siteId,
        shortId: `SYN-${String(index).padStart(3, "0")}-${n + 1}`,
        kind: "action",
        type: "action",
        status,
        category: categories[(index + n) % categories.length],
        description:
          "Synthetic reporting test issue. Photo is a reusable test fixture, not evidence from this site.",
        guidance:
          "Synthetic test record for reviewing the reporting interface.",
        sourceArtifactIds: [artifacts[n]],
        source: { artifactId: artifacts[n] },
        createdAt: startedAt,
        updatedAt,
        ...(status === "completed"
          ? {
              latestUpdateId: `${taskId}-completed`,
              completedAt: resolvedAt,
              resolvedAt,
              completionMethod: "manual",
              completedBy: "synthetic-local-user",
            }
          : {}),
        ...(status === "in_progress"
          ? {
              inProgressAt: updatedAt,
              latestUpdateLabel:
                "Synthetic response recorded; issue remains open.",
            }
          : {}),
        ...(status === "cannot_do"
          ? { cannotDo: { reason: "Synthetic test: equipment unavailable." } }
          : {}),
      };
      await put(task);
      const noteAt = new Date(Date.parse(startedAt) + 10 * 60000).toISOString();
      for (const update of [
        {
          updateId: `${taskId}-note`,
          occurredAt: noteAt,
          type: "note",
          text: "Synthetic test note: team inspected the area.",
          label: "Note added",
        },
        ...(status === "completed"
          ? [
              {
                updateId: `${taskId}-completed`,
                occurredAt: resolvedAt,
                type: "task_completed",
                label: "Site marked as resolved",
                text: "Synthetic test: marked completed by the local test user.",
              },
            ]
          : []),
      ]) {
        await put({
          ...taskUpdateKey(siteId, taskId, update.occurredAt, update.updateId),
          ...taskUpdateTimelineGsi(siteId, update.occurredAt, update.updateId),
          taskId,
          checkId,
          actorId: "synthetic-local-user",
          // These fixtures already include their documentation.
          documentationState: "closed",
          ...update,
        });
      }
      summary.issues++;
      if (date.startsWith("2026-10")) {
        summary.octoberIssues++;
        if (status === "completed" && resolvedAt < "2026-11-01T07:00:00.000Z")
          summary.octoberResolved++;
      }
    }
    // Publish the header last, once its photos and tasks exist.
    await put({
      ...checkHeaderKey(siteId, checkId),
      ...checkTimelineGsi(siteId, startedAt),
      checkId,
      siteId,
      status: "completed",
      flowType: "perimeter",
      startedAt,
      completedAt,
      photoCount,
      textCount: 0,
      evidenceKind: "photos",
      issueCount,
      maxSeverity: issueCount ? 1 : 0,
      summary: "Synthetic reporting fixture",
      createdBy: "synthetic-local-user",
    });
    summary.checks++;
    summary.photos += photoCount;
    if (date.startsWith("2026-10")) summary.octoberChecks++;
  }
}
console.log(JSON.stringify(summary, null, 2));
