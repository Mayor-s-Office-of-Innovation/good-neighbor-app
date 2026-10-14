// Dedicated SQS function: no normal analysis, guidance, or Bedrock imports.
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getObjectBytes } from "../s3.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  analysisRevision,
  observationId,
  projectionKey,
} from "../analysis/duplicates/jobs.js";
import { prepareImage } from "../analysis/duplicates/image-features.js";
import {
  createComparisonClient,
  IMAGE_MATCHER_VERSION,
  eligibleImages,
  matchImages,
  LOOKBACK_MS,
} from "../analysis/duplicates/image-matcher.js";

/**
 * @param {string} table
 * @param {{pk:string,sk:string}} key
 * @returns {Promise<Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>|undefined>}
 */
async function get(table, key) {
  return (
    await ddb.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    )
  ).Item;
}
/**
 * @param {string} table
 * @param {string} siteId
 * @param {string} start
 * @param {string} end
 * @returns {Promise<Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>[]>}
 */
async function query(table, siteId, start, end) {
  /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>[]} */ const items =
    [];
  let cursor;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":start": `DUP_OBSERVATION#${start}`,
          ":end": `DUP_OBSERVATION#${end}#\uffff`,
        },
        ExclusiveStartKey: cursor,
      }),
    );
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}
/**
 * @param {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} item
 * @returns {Promise<Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue> & import("../analysis/duplicates/image-matcher.js").ImageObservation>}
 */
async function loadImage(item) {
  const object = await getObjectBytes({
    bucket: process.env.S3_UPLOAD_BUCKET ?? "",
    key: item.s3Key,
  });
  if (object.bytes.length > 10 * 1024 * 1024)
    throw new Error("Comparison image exceeds input limit");
  return /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue> & import("../analysis/duplicates/image-matcher.js").ImageObservation} */ ({
    ...item,
    ...(await prepareImage(object.bytes, item.contentType)),
  });
}
/** @type {import("aws-lambda").SQSHandler} */
export const handler = async (event) => {
  const failures = [];
  const table = process.env.DYNAMO_TABLE;
  if (!table || !process.env.DUPLICATE_ANALYZER_BASE_URL)
    throw new Error("Missing duplicate worker configuration");
  const key = await getAnalyzerApiKey({
    dynamoTable: table,
    uploadBucket: process.env.S3_UPLOAD_BUCKET ?? "",
    queueUrl: "unused",
    analyzerApiKeySecretArn: process.env.DUPLICATE_ANALYZER_API_KEY_SECRET_ARN,
  });
  const compare = createComparisonClient({
    baseUrl: process.env.DUPLICATE_ANALYZER_BASE_URL,
    apiKey: key,
  });
  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body);
      if (!job.siteId || !job.checkId || !job.artifactId || !job.revision)
        throw new Error("Invalid duplicate job");
      if (job.lifecycleChange) {
        const { SQSClient, SendMessageCommand } = await import(
          "@aws-sdk/client-sqs"
        );
        const sqs = new SQSClient({});
        const observed = Date.parse(job.observedAt);
        if (!Number.isFinite(observed))
          throw new Error("Invalid lifecycle observation time");
        const peers = await query(
          table,
          job.siteId,
          new Date(observed - LOOKBACK_MS).toISOString(),
          new Date(observed + LOOKBACK_MS).toISOString(),
        );
        for (const peer of peers) {
          const resultKey = {
            pk: peer.pk,
            sk: `DUP_RESULT#${peer.id}#${peer.revision}`,
          };
          const previous = await get(table, resultKey);
          if (
            peer.id !== job.id &&
            !previous?.candidateRevisions?.some(
              (
                /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
              ) => c.id === job.id,
            )
          )
            continue;
          await ddb.send(
            new PutCommand({
              TableName: table,
              Item: {
                ...resultKey,
                status: "pending",
                possibleDuplicate: null,
                shadow: true,
                sourceRevision: peer.revision,
                invalidatedAt: new Date().toISOString(),
              },
            }),
          );
          if (process.env.DUPLICATE_QUEUE_URL)
            await sqs.send(
              new SendMessageCommand({
                QueueUrl: process.env.DUPLICATE_QUEUE_URL,
                MessageBody: JSON.stringify({
                  siteId: job.siteId,
                  checkId: peer.checkId,
                  artifactId: peer.artifactId,
                  revision: peer.revision,
                }),
              }),
            );
        }
        continue;
      }
      const analysisKey = {
        pk: `SITE#${job.siteId}`,
        sk: `CHECK#${job.checkId}#ANALYSIS#${job.artifactId}`,
      };
      const artifactKey = {
        pk: analysisKey.pk,
        sk: `CHECK#${job.checkId}#ART#${job.artifactId}`,
      };
      const analysis = await get(table, analysisKey),
        artifact = await get(table, artifactKey);
      if (
        !analysis ||
        !artifact ||
        analysis.status !== "analyzed" ||
        analysisRevision(analysis) !== job.revision
      )
        continue;
      if (!artifact.s3Key) continue; // Text-only behavior is outside this experiment.
      const observed = Date.parse(artifact.capturedAt ?? "");
      if (!Number.isFinite(observed))
        throw new Error("Capture time unavailable");
      const coverage = await get(table, {
        pk: analysisKey.pk,
        sk: "DUP_COVERAGE",
      });
      if (
        !coverage ||
        !Number.isFinite(Date.parse(coverage.coverageFrom)) ||
        observed - LOOKBACK_MS < Date.parse(coverage.coverageFrom)
      ) {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: analysisKey.pk,
              sk: `DUP_RESULT#${observationId(job.checkId, job.artifactId)}#${job.revision}`,
              status: "insufficient_evidence",
              possibleDuplicate: null,
              shadow: true,
              sourceRevision: job.revision,
              reason: "Five-day candidate history is incomplete",
              evaluatedAt: new Date().toISOString(),
            },
          }),
        );
        continue;
      }
      const id = observationId(job.checkId, job.artifactId);
      const projection = {
        ...projectionKey(job.siteId, artifact.capturedAt, id),
        id,
        siteId: job.siteId,
        sourceId: id,
        checkId: job.checkId,
        artifactId: job.artifactId,
        revision: job.revision,
        observedAt: new Date(observed).toISOString(),
        availableAt: analysis.analyzedAt,
        contentType: artifact.contentType,
        s3Key: artifact.s3Key,
        conditions: (analysis.concerns ?? [])
          .filter(
            (
              /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
            ) => c.rating > 0 && c.conditionId,
          )
          .map(
            (
              /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
            ) => ({
              id: c.conditionId,
              description: c.explanation,
            }),
          ),
      };
      // Stable capture-time key lets amendments replace, rather than append, evidence.
      const prior = await get(table, { pk: projection.pk, sk: projection.sk });
      if (prior?.resolvedAt) {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: projection.pk,
              sk: `DUP_RESULT#${id}#${job.revision}`,
              status: "insufficient_evidence",
              possibleDuplicate: null,
              shadow: true,
              sourceRevision: job.revision,
              reason: "Source is physically resolved",
              evaluatedAt: new Date().toISOString(),
            },
          }),
        );
        continue;
      }
      const projectionCondition = prior
        ? "revision = :revision"
        : "attribute_not_exists(sk)";
      const lifecycleCondition = prior?.resolvedAt
        ? "resolvedAt = :resolved"
        : "attribute_not_exists(resolvedAt)";
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: analysisKey,
                ConditionExpression:
                  "analysisId = :id AND concerns = :concerns",
                ExpressionAttributeValues: {
                  ":id": analysis.analysisId,
                  ":concerns": analysis.concerns,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: projection,
                ConditionExpression: `(${projectionCondition}) AND (${lifecycleCondition})`,
                ...(prior
                  ? {
                      ExpressionAttributeValues: {
                        ":revision": prior.revision,
                        ...(prior.resolvedAt
                          ? { ":resolved": prior.resolvedAt }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
          ],
        }),
      );
      const currentAvailable = Date.parse(projection.availableAt);
      if (!Number.isFinite(currentAvailable))
        throw new Error("Analysis availability unavailable");
      const listed = await query(
        table,
        job.siteId,
        new Date(observed - LOOKBACK_MS).toISOString(),
        projection.observedAt,
      );
      // Read source-of-truth analyses to exclude stale projections before model work.
      const candidates = [];
      for (const candidate of listed) {
        if (candidate.id === id) continue;
        const actual = await get(table, {
          pk: projection.pk,
          sk: `CHECK#${candidate.checkId}#ANALYSIS#${candidate.artifactId}`,
        });
        if (
          actual &&
          actual.status === "analyzed" &&
          analysisRevision(actual) === candidate.revision
        )
          candidates.push(candidate);
      }
      const eligible = eligibleImages(
        { ...projection, availableAt: new Date().toISOString() },
        /** @type {Omit<import("../analysis/duplicates/image-matcher.js").ImageObservation,"image">[]} */ (
          candidates
        ),
      );
      const source = await loadImage(projection);
      const loaded = [];
      for (const candidate of eligible) loaded.push(await loadImage(candidate));
      const resultKey = {
        pk: projection.pk,
        sk: `DUP_RESULT#${id}#${job.revision}`,
      };
      const cachedCompare = async (
        /** @type {import("../analysis/duplicates/image-matcher.js").ComparisonRequest} */ request,
      ) => {
        const { createHash } = await import("node:crypto");
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              matcherVersion: IMAGE_MATCHER_VERSION,
              version: process.env.DUPLICATE_COMPARISON_CACHE_VERSION,
              request,
            }),
          )
          .digest("hex");
        const cacheKey = { pk: projection.pk, sk: `DUP_COMPARISON#${digest}` };
        const cached = await get(table, cacheKey);
        if (cached?.response) return cached.response;
        const response = await compare(request);
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              ...cacheKey,
              response,
              expiresAt: Math.floor(Date.now() / 1000) + 5 * 86400,
            },
          }),
        );
        return response;
      };
      const result = await matchImages({
        source:
          /** @type {import("../analysis/duplicates/image-matcher.js").ImageObservation} */ (
            source
          ),
        candidates:
          /** @type {import("../analysis/duplicates/image-matcher.js").ImageObservation[]} */ (
            loaded
          ),
        compare: cachedCompare,
      });
      if (result.status === "failed") {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              ...resultKey,
              ...result,
              evaluatedAt: new Date().toISOString(),
              shadow: true,
            },
          }),
        );
        throw new Error("Duplicate comparison failed");
      }
      // Re-read revisions and physical-resolution state immediately before publishing.
      const freshSource = await get(table, analysisKey);
      if (!freshSource || analysisRevision(freshSource) !== job.revision)
        continue;
      const sourceProjection = await get(table, {
        pk: projection.pk,
        sk: projection.sk,
      });
      if (sourceProjection?.resolvedAt) continue;
      for (const candidate of loaded) {
        const fresh = await get(table, {
          pk: projection.pk,
          sk: `CHECK#${candidate.checkId}#ANALYSIS#${candidate.artifactId}`,
        });
        const lifecycle = await get(table, {
          pk: candidate.pk,
          sk: candidate.sk,
        });
        if (
          !fresh ||
          analysisRevision(fresh) !== candidate.revision ||
          lifecycle?.resolvedAt
        )
          throw new Error("Candidate changed during comparison");
      }
      /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */
      const targetChecks = [];
      const targets = loaded.filter((candidate) =>
        result.suggestions.some((row) => row.candidate_id === candidate.id),
      );
      if (targets.length > 48)
        throw new Error(
          "Too many atomic target checks; leave evaluation pending",
        );
      for (const target of targets) {
        const actual = await get(table, {
          pk: projection.pk,
          sk: `CHECK#${target.checkId}#ANALYSIS#${target.artifactId}`,
        });
        if (!actual || analysisRevision(actual) !== target.revision)
          throw new Error("Target revision changed");
        targetChecks.push(
          {
            ConditionCheck: {
              TableName: table,
              Key: {
                pk: projection.pk,
                sk: `CHECK#${target.checkId}#ANALYSIS#${target.artifactId}`,
              },
              ConditionExpression: "analysisId = :id AND concerns = :concerns",
              ExpressionAttributeValues: {
                ":id": actual.analysisId,
                ":concerns": actual.concerns,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: table,
              Key: { pk: target.pk, sk: target.sk },
              ConditionExpression:
                "revision = :revision AND attribute_not_exists(resolvedAt)",
              ExpressionAttributeValues: { ":revision": target.revision },
            },
          },
        );
      }
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...targetChecks,
            {
              ConditionCheck: {
                TableName: table,
                Key: { pk: projection.pk, sk: projection.sk },
                ConditionExpression:
                  "revision = :revision AND attribute_not_exists(resolvedAt)",
                ExpressionAttributeValues: { ":revision": job.revision },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: analysisKey,
                ConditionExpression:
                  "analysisId = :id AND concerns = :concerns",
                ExpressionAttributeValues: {
                  ":id": freshSource.analysisId,
                  ":concerns": freshSource.concerns,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...resultKey,
                  ...result,
                  candidateRevisions: loaded.map((c) => ({
                    id: c.id,
                    revision: c.revision,
                  })),
                  evaluatedAt: new Date().toISOString(),
                  shadow: true,
                },
              },
            },
          ],
        }),
      );
      // Reconcile peers arriving concurrently or late. Each peer is revisited only
      // when its evaluation did not include this revision; no circular requeue loop.
      const peers = await query(
        table,
        job.siteId,
        projection.observedAt,
        new Date(observed + LOOKBACK_MS).toISOString(),
      );
      const { SQSClient, SendMessageCommand } = await import(
        "@aws-sdk/client-sqs"
      );
      const sqs = new SQSClient({});
      for (const peer of peers) {
        if (peer.id === id || !process.env.DUPLICATE_QUEUE_URL) continue;
        const previous = await get(table, {
          pk: projection.pk,
          sk: `DUP_RESULT#${peer.id}#${peer.revision}`,
        });
        if (
          previous?.candidateRevisions?.some(
            (
              /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
            ) => c.id === id && c.revision === job.revision,
          )
        )
          continue;
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.DUPLICATE_QUEUE_URL,
            MessageBody: JSON.stringify({
              siteId: job.siteId,
              checkId: peer.checkId,
              artifactId: peer.artifactId,
              revision: peer.revision,
            }),
          }),
        );
      }
    } catch {
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
