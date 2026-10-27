import { peerFanout } from "../analysis/duplicates/peer-fanout.js";
import { processingState } from "../analysis/duplicates/result-state.js";
import { createComparisonPacer } from "../analysis/duplicates/request-pacing.js";
import { preparedRetention } from "../analysis/duplicates/prepared-retention.js";
import { duplicateEvent } from "../analysis/duplicates/monitoring.js";
import { ensureDuplicateHistory } from "../analysis/duplicates/history.js";
import {
  reconcileObservation,
  taskForIssue,
  siteReader,
} from "../analysis/duplicates/links.js";
// Dedicated SQS function: no normal analysis, guidance, or Bedrock imports.
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getObjectBytes, headObject } from "../s3.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  analysisRevision,
  observationId,
  projectionKey,
} from "../analysis/duplicates/jobs.js";
import { reusableImage } from "../analysis/duplicates/prepared-cache.js";
import { latencyTracker } from "../analysis/duplicates/latency.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
const preparedStore = new S3Client(
  process.env.AWS_ENDPOINT_URL_S3 ? { forcePathStyle: true } : {},
);
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
        ScanIndexForward: false,
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
  if (!item.s3Key) return /** @type {any} */ ({ ...item, image: undefined });
  const bucket = process.env.S3_UPLOAD_BUCKET ?? "";
  const metadata = await headObject({ bucket, key: item.s3Key });
  const policy = preparedRetention(metadata.lastModified);
  if (policy.expired) throw new Error("Comparison media retention expired");
  const prepared = await reusableImage({
    identity: `${bucket}:${item.s3Key}`,
    contentType: item.contentType,
    read: async (key) => {
      if (!policy.cacheable) return undefined;
      try {
        const cached = JSON.parse(
          (
            await getObjectBytes({
              bucket,
              key: `duplicate-prepared/${key}.json`,
            })
          ).bytes.toString("utf8"),
        );
        return cached.sourceExpiresAt === policy.sourceExpiresAt &&
          cached.expiresAt > Date.now()
          ? cached
          : undefined;
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof Error &&
            ["NoSuchKey", "NotFound"].includes(error.name))
        )
          return undefined;
        throw error;
      }
    },
    write: async (key, value) => {
      if (!policy.cacheable) return;
      await preparedStore.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `duplicate-prepared/${key}.json`,
          Body: JSON.stringify({
            ...value,
            sourceExpiresAt: policy.sourceExpiresAt,
            expiresAt: Math.min(
              Date.now() + 3 * 86400000,
              policy.sourceExpiresAt,
            ),
          }),
          ContentType: "application/json",
        }),
      );
    },
    load: async () => (await getObjectBytes({ bucket, key: item.s3Key })).bytes,
  });
  return /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue> & import("../analysis/duplicates/image-matcher.js").ImageObservation} */ ({
    ...item,
    id: item.id,
    revision: item.revision,
    ...prepared,
  });
}
/** @type {import("aws-lambda").SQSHandler} */
export const handler = async (event) => {
  const failures = [];
  const table = process.env.DYNAMO_TABLE;
  if (!table || !process.env.DUPLICATE_ANALYZER_BASE_URL)
    throw new Error("Missing duplicate worker configuration");
  /** @type {import("../analysis/duplicates/image-matcher.js").Compare|undefined} */
  let comparisonClient;
  for (const record of event.Records) {
    const timing = latencyTracker();
    const sent = Number(record.attributes?.SentTimestamp);
    if (Number.isFinite(sent)) timing.add("queueMs", Date.now() - sent);
    /** @type {Record<string, any>} */
    let job = {};
    try {
      job = JSON.parse(record.body);
      if (job.reconcileOnly) {
        await reconcileObservation(
          table,
          job.siteId,
          job.checkId,
          job.artifactId,
        );
        const current = await get(table, {
          pk: `SITE#${job.siteId}`,
          sk: `CHECK#${job.checkId}#ANALYSIS#${job.artifactId}`,
        });
        const time = Date.parse(
          current?.generatedAt ?? current?.analyzedAt ?? "",
        );
        if (Number.isFinite(time))
          for (const peer of await query(
            table,
            job.siteId,
            new Date(time).toISOString(),
            new Date(time + LOOKBACK_MS).toISOString(),
          )) {
            if (
              peer.checkId !== job.checkId ||
              peer.artifactId !== job.artifactId
            )
              await reconcileObservation(
                table,
                job.siteId,
                peer.checkId,
                peer.artifactId,
              );
          }
        continue;
      }
      if (job.prepareOnly && job.siteId && job.checkId && job.artifactId) {
        const artifact = await get(table, {
          pk: `SITE#${job.siteId}`,
          sk: `CHECK#${job.checkId}#ART#${job.artifactId}`,
        });
        if (artifact?.s3Key) await loadImage(artifact);
        timing.mark("preparationCompletedMs");
        continue;
      }
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
                shadow: false,
                sourceRevision: peer.revision,
                invalidatedAt: new Date().toISOString(),
                // Stable across redelivery of the same lifecycle event.
                queuedAt:
                  job.enqueuedAt ??
                  (Number.isFinite(sent)
                    ? new Date(sent).toISOString()
                    : (previous?.queuedAt ??
                      previous?.invalidatedAt ??
                      new Date().toISOString())),
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
      const analyzedAt = Date.parse(analysis.analyzedAt ?? "");
      if (Number.isFinite(analyzedAt))
        timing.add("analysisToWorkerMs", Date.now() - analyzedAt);
      const observed = Date.parse(
        analysis.generatedAt ?? analysis.analyzedAt ?? "",
      );
      if (!Number.isFinite(observed))
        throw new Error("Issue generation time unavailable");
      const coverage = await get(table, {
        pk: analysisKey.pk,
        sk: "DUP_COVERAGE",
      });
      if (
        !coverage ||
        !Number.isFinite(Date.parse(coverage.coverageFrom)) ||
        observed - LOOKBACK_MS < Date.parse(coverage.coverageFrom)
      ) {
        await ensureDuplicateHistory(
          table,
          job.siteId,
          new Date(observed - LOOKBACK_MS).toISOString(),
        );
      }
      const id = observationId(job.checkId, job.artifactId);
      const projection = {
        ...projectionKey(
          job.siteId,
          analysis.generatedAt ?? analysis.analyzedAt,
          id,
        ),
        id,
        siteId: job.siteId,
        sourceId: id,
        checkId: job.checkId,
        artifactId: job.artifactId,
        revision: job.revision,
        observedAt: new Date(observed).toISOString(),
        availableAt: analysis.analyzedAt,
        ...(artifact.capturedAt ? { capturedAt: artifact.capturedAt } : {}),
        ...(artifact.s3Key
          ? { contentType: artifact.contentType, s3Key: artifact.s3Key }
          : {}),
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
              category: c.category,
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
              shadow: false,
              sourceRevision: job.revision,
              reason: "Source is physically resolved",
              evaluatedAt: new Date().toISOString(),
            },
          }),
        );
        continue;
      }
      const removeResolved = async (/** @type {any} */ observation) => {
        const kept = [];
        for (const condition of observation.conditions ?? []) {
          const task = await taskForIssue(
            job.siteId,
            { observationId: observation.id, conditionId: condition.id },
            siteReader(table, job.siteId),
          );
          if (!task?.resolvedAt || Date.parse(task.resolvedAt) > observed)
            kept.push(condition);
        }
        return { ...observation, conditions: kept };
      };
      const source = await loadImage(await removeResolved(projection));
      if (source.fingerprint)
        Object.assign(projection, {
          fingerprint: source.fingerprint,
          perceptualHash: source.perceptualHash,
        });
      timing.mark("sourcePreparationCompletedMs");
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
          candidates.push({
            ...candidate,
            observedAt: actual.generatedAt ?? actual.analyzedAt,
            availableAt: actual.analyzedAt,
            conditions: (actual.concerns ?? [])
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
                  category: c.category,
                  description: c.explanation,
                }),
              ),
          });
      }
      const preliminary = eligibleImages(
        {
          ...projection,
          conditions: source.conditions,
          availableAt: new Date().toISOString(),
        },
        /** @type {Omit<import("../analysis/duplicates/image-matcher.js").ImageObservation,"image">[]} */ (
          candidates
        ),
      );
      const eligible = (
        await Promise.all(preliminary.map(removeResolved))
      ).filter((c) => c.conditions.length);
      timing.mark("retrievalCompletedMs");
      /** @type {Awaited<ReturnType<typeof loadImage>>[]} */
      const loaded = [];
      // Prepare candidates only when reached; early matches avoid remaining S3/image work.
      for (const candidate of eligible)
        loaded.push(
          /** @type {Awaited<ReturnType<typeof loadImage>>} */ ({
            ...candidate,
            ...(candidate.s3Key
              ? { image: { content_type: "image/jpeg", base64: "" } }
              : {}),
          }),
        );
      const resultKey = {
        pk: projection.pk,
        sk: `DUP_RESULT#${id}#${job.revision}`,
      };
      let comparisonCacheHits = 0;
      let modelId = "";
      let comparisonVersion = "";
      const cachedCompare = async (
        /** @type {import("../analysis/duplicates/image-matcher.js").ComparisonRequest} */ request,
      ) => {
        await Promise.all(
          request.candidates.map(async (item) => {
            const candidate =
              item.id === source.id
                ? source
                : loaded.find((c) => c.id === item.id);
            if (!candidate) throw new Error("Unknown preparation target");
            if (candidate.s3Key && !candidate.image?.base64) {
              const preparationStarted = Date.now();
              try {
                Object.assign(candidate, await loadImage(candidate));
              } finally {
                timing.add(
                  "candidatePreparationMs",
                  Date.now() - preparationStarted,
                );
              }
            }
            item.image = candidate.image;
          }),
        );
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
        if (cached?.response) {
          comparisonCacheHits++;
          modelId = cached.response.model?.model_id;
          comparisonVersion = cached.response.comparison_version;
          return cached.response;
        }
        if (!comparisonClient) {
          const key = await getAnalyzerApiKey({
            dynamoTable: table,
            uploadBucket: process.env.S3_UPLOAD_BUCKET ?? "",
            queueUrl: "unused",
            analyzerApiKey: process.env.DUPLICATE_ANALYZER_API_KEY,
            analyzerApiKeySecretArn:
              process.env.DUPLICATE_ANALYZER_API_KEY_SECRET_ARN,
          });
          comparisonClient = createComparisonClient({
            baseUrl: process.env.DUPLICATE_ANALYZER_BASE_URL ?? "",
            apiKey: key,
            pace:
              Number(
                process.env.DUPLICATE_COMPARISON_REQUESTS_PER_SECOND ?? 0,
              ) === 0
                ? undefined
                : createComparisonPacer({
                    ddb,
                    table,
                    baseUrl: process.env.DUPLICATE_ANALYZER_BASE_URL ?? "",
                    requestsPerSecond: Number(
                      process.env.DUPLICATE_COMPARISON_REQUESTS_PER_SECOND,
                    ),
                  }),
          });
        }
        const response = await comparisonClient(request);
        modelId = response.model.model_id;
        comparisonVersion = response.comparison_version;
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
      const published = new Set();
      const monitoredComparisons = new Set();
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
        onProgress: async (progress) => {
          for (const row of progress.comparisons) {
            if (monitoredComparisons.has(row.candidate_id)) continue;
            monitoredComparisons.add(row.candidate_id);
            const target = loaded.find((c) => c.id === row.candidate_id);
            duplicateEvent("comparison", {
              siteId: job.siteId,
              observationId: id,
              candidateId: row.candidate_id,
              modelId,
              comparisonVersion,
              matcherVersion: IMAGE_MATCHER_VERSION,
              outcome:
                row.verdict === "same_issue"
                  ? "matched"
                  : row.verdict === "different_issue"
                    ? "no_match"
                    : "uncertain",
              confidence: row.confidence,
              evidenceKind:
                source.image && target?.image
                  ? "image"
                  : source.image || target?.image
                    ? "mixed"
                    : "text",
              phase: progress.phase,
              elapsedMs: progress.elapsedMs,
            });
          }
          if (progress.phase === "fast") timing.mark("fastPhaseCompletedMs");
          for (const issue of progress.conditionResults) {
            if (
              issue.possibleDuplicate !== true ||
              !issue.duplicateOf ||
              published.has(issue.conditionId)
            )
              continue;
            const target = loaded.find(
              (c) => c.id === issue.duplicateOf?.observationId,
            );
            const fresh = await get(table, analysisKey);
            if (!(await get(table, artifactKey)))
              throw new Error("Source artifact removed");
            if (!target || !fresh || analysisRevision(fresh) !== job.revision)
              throw new Error("Stale source progress");
            const targetKey = {
              pk: projection.pk,
              sk: `CHECK#${target.checkId}#ANALYSIS#${target.artifactId}`,
            };
            const targetArtifactKey = {
              pk: projection.pk,
              sk: `CHECK#${target.checkId}#ART#${target.artifactId}`,
            };
            const actual = await get(table, targetKey);
            if (!(await get(table, targetArtifactKey)))
              throw new Error("Target artifact removed");
            if (!actual || analysisRevision(actual) !== target.revision)
              throw new Error("Stale target progress");
            await ddb.send(
              new TransactWriteCommand({
                TransactItems: [
                  {
                    ConditionCheck: {
                      TableName: table,
                      Key: artifactKey,
                      ConditionExpression: "attribute_exists(sk)",
                    },
                  },
                  {
                    ConditionCheck: {
                      TableName: table,
                      Key: targetArtifactKey,
                      ConditionExpression: "attribute_exists(sk)",
                    },
                  },
                  {
                    ConditionCheck: {
                      TableName: table,
                      Key: analysisKey,
                      ConditionExpression:
                        "analysisId = :id AND concerns = :concerns",
                      ExpressionAttributeValues: {
                        ":id": fresh.analysisId,
                        ":concerns": fresh.concerns,
                      },
                    },
                  },
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
                      Key: targetKey,
                      ConditionExpression:
                        "analysisId = :id AND concerns = :concerns",
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
                      ExpressionAttributeValues: {
                        ":revision": target.revision,
                      },
                    },
                  },
                  {
                    Put: {
                      TableName: table,
                      Item: {
                        pk: projection.pk,
                        sk: `DUP_ISSUE#${id}#${job.revision}#${issue.conditionId}`,
                        sourceRevision: job.revision,
                        ...issue,
                        targetProjectionKey: { pk: target.pk, sk: target.sk },
                        targetAnalysisKey: targetKey,
                        targetArtifactKey,
                        updatedAt: new Date().toISOString(),
                        latency: timing.snapshot(),
                        shadow: false,
                      },
                    },
                  },
                ],
              }),
            );
            await reconcileObservation(
              table,
              job.siteId,
              job.checkId,
              job.artifactId,
            );
            published.add(issue.conditionId);
            if (published.size === 1) {
              timing.mark("firstPositivePublishedMs");
              if (Number.isFinite(analyzedAt))
                timing.add(
                  "analysisToFirstPositiveMs",
                  Date.now() - analyzedAt,
                );
            }
          }
        },
      });
      timing.mark("comparisonCompletedMs");
      // Re-read revisions and physical-resolution state immediately before publishing.
      const freshSource = await get(table, analysisKey);
      if (
        !freshSource ||
        analysisRevision(freshSource) !== job.revision ||
        !(await get(table, artifactKey))
      )
        continue;
      const sourceProjection = await get(table, {
        pk: projection.pk,
        sk: projection.sk,
      });
      if (sourceProjection?.resolvedAt) continue;
      for (const candidate of loaded.filter((c) =>
        result.comparisons.some((r) => r.candidate_id === c.id),
      )) {
        if (
          !(await get(table, {
            pk: projection.pk,
            sk: `CHECK#${candidate.checkId}#ART#${candidate.artifactId}`,
          }))
        )
          throw new Error("Candidate artifact removed");
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
      if (targets.length > 30)
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
                sk: `CHECK#${target.checkId}#ART#${target.artifactId}`,
              },
              ConditionExpression: "attribute_exists(sk)",
            },
          },
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
                Key: artifactKey,
                ConditionExpression: "attribute_exists(sk)",
              },
            },
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
                  processingState: processingState(result),
                  latency: timing.snapshot(),
                  candidateRevisions: loaded.map(
                    (
                      /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
                    ) => ({
                      id: c.id,
                      revision: c.revision,
                    }),
                  ),
                  evaluatedAt: new Date().toISOString(),
                  shadow: false,
                },
              },
            },
          ],
        }),
      );
      await reconcileObservation(
        table,
        job.siteId,
        job.checkId,
        job.artifactId,
      );
      timing.mark("resultPublishedMs");
      for (const issue of result.conditionResults)
        duplicateEvent(
          "issue_result",
          {
            siteId: job.siteId,
            observationId: id,
            conditionId: issue.conditionId,
            candidateId: issue.duplicateOf?.observationId,
            candidateConditionId: issue.duplicateOf?.conditionId,
            matcherVersion: IMAGE_MATCHER_VERSION,
            modelId,
            outcome:
              issue.possibleDuplicate === true
                ? "matched"
                : issue.assessmentOutcome === "incomplete"
                  ? "incomplete"
                  : issue.possibleDuplicate === false
                    ? "no_match"
                    : "pending",
            failedCandidates: issue.failedCandidateCount ?? 0,
            confidence: issue.possibleDuplicate === true ? "high" : undefined,
          },
          [
            {
              name:
                issue.possibleDuplicate === true
                  ? "DuplicateMatchedIssues"
                  : issue.assessmentOutcome === "incomplete"
                    ? "DuplicateIncompleteNoMatchIssues"
                    : issue.possibleDuplicate === false
                      ? "DuplicateNoMatchIssues"
                      : "DuplicatePendingIssues",
              value: 1,
            },
          ],
        );
      const snapshot = timing.snapshot();
      duplicateEvent(
        "search_complete",
        {
          siteId: job.siteId,
          observationId: id,
          matcherVersion: IMAGE_MATCHER_VERSION,
          modelId,
          outcome: processingState(result),
          totalMs: snapshot.totalMs,
          failedCandidates: result.failedCandidateIds.length,
          candidateCount: loaded.length,
          cacheHits: comparisonCacheHits,
          firstMatchMs: snapshot.firstPositivePublishedMs,
        },
        [
          { name: "DuplicateSearchCompleted", value: 1 },
          {
            name: "DuplicateSearchMs",
            value: snapshot.totalMs,
            unit: "Milliseconds",
          },
          { name: "DuplicateComparisons", value: result.comparisons.length },
          {
            name: "DuplicateFailedCandidates",
            value: result.failedCandidateIds.length,
          },
          { name: "DuplicateComparisonCacheHits", value: comparisonCacheHits },
          {
            name: "DuplicatePreparationCacheHits",
            value: [source, ...loaded].filter((c) => c.preparationCacheHit)
              .length,
          },
          ...(Number.isFinite(snapshot.firstPositivePublishedMs)
            ? [
                {
                  name: "DuplicateFirstMatchMs",
                  value: snapshot.firstPositivePublishedMs,
                  unit: /** @type {const} */ ("Milliseconds"),
                },
              ]
            : []),
        ],
      );
      if (Number.isFinite(analyzedAt))
        timing.add("analysisToResultPublishedMs", Date.now() - analyzedAt);
      if (result.status === "failed")
        throw new Error("Duplicate comparison failed");
      // Always reconcile existing dependents after result replacement/recovery.
      // The checkpoint suppresses job sends only, not link reconciliation.
      // Missing candidateRevisions alone is not an invalidation token.
      const peerCheckpoint = {
        pk: projection.pk,
        sk: `DUP_PEER_RECONCILIATION#${id}#${job.revision}`,
      };
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
      /** @type {typeof peers} */
      const pendingPeers = [];
      for (const peer of peers) {
        if (peer.id === id) continue;
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
        ) {
          await reconcileObservation(
            table,
            job.siteId,
            peer.checkId,
            peer.artifactId,
          );
          continue;
        }
        if (
          !eligibleImages(
            /** @type {Omit<import("../analysis/duplicates/image-matcher.js").ImageObservation,"image">} */ ({
              ...peer,
              availableAt: new Date().toISOString(),
            }),
            [source],
          ).length
        )
          continue;
        pendingPeers.push(peer);
      }
      if (!process.env.DUPLICATE_QUEUE_URL) continue;
      await peerFanout({
        ddb,
        table,
        key: peerCheckpoint,
        // Projection keys order peers by generation time and observation ID.
        // Rebuilding/filtering the pending list must not shift the saved cursor.
        work: async (assertLease, sendPeer) => {
          pendingPeers.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
          for (const peer of pendingPeers) {
            assertLease();
            await sendPeer(peer.sk, () =>
              sqs.send(
                new SendMessageCommand({
                  QueueUrl: process.env.DUPLICATE_QUEUE_URL,
                  MessageBody: JSON.stringify({
                    siteId: job.siteId,
                    checkId: peer.checkId,
                    artifactId: peer.artifactId,
                    revision: peer.revision,
                  }),
                }),
                // A stalled send cannot consume the entire lease. Delivery may
                // still be ambiguous after abort, so checkpoint only on success.
                { abortSignal: globalThis.AbortSignal.timeout(15_000) },
              ),
            );
          }
        },
      });
    } catch (error) {
      duplicateEvent("worker_failed", {
        siteId: job?.siteId,
        observationId:
          job?.checkId && job?.artifactId
            ? observationId(job.checkId, job.artifactId)
            : undefined,
        messageId: record.messageId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        jobKind: job?.prepareOnly
          ? "prepare"
          : job?.reconcileOnly
            ? "reconcile"
            : "compare",
        attempt: Number(record.attributes?.ApproximateReceiveCount),
        outcome: "retrying",
      });
      failures.push({ itemIdentifier: record.messageId });
    } finally {
      const snapshot = timing.snapshot();
      duplicateEvent(
        "worker_complete",
        {
          outcome: failures.some((f) => f.itemIdentifier === record.messageId)
            ? "retrying"
            : "complete",
          queueMs: snapshot.queueMs,
          totalMs: snapshot.totalMs,
        },
        [
          { name: "DuplicateWorkerAttempts", value: 1 },
          {
            name: "DuplicateWorkerFailures",
            value: failures.some((f) => f.itemIdentifier === record.messageId)
              ? 1
              : 0,
          },
          ...(Number.isFinite(snapshot.queueMs)
            ? [
                {
                  name: "DuplicateQueueMs",
                  value: snapshot.queueMs,
                  unit: /** @type {const} */ ("Milliseconds"),
                },
              ]
            : []),
        ],
      );
    }
  }
  return { batchItemFailures: failures };
};
