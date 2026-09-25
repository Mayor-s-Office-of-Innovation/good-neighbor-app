import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { synthesizeCheck } from "../analysis/synthesize-check.js";
import {
  checkAnalysisPrefix,
  checkArtifactPrefix,
  checkChildrenPrefix,
  checkHeaderKey,
  checkTimelineGsi,
  GSI1_NAME,
  sitePk,
} from "./keys.js";

/**
 * Read every page for one check's header + children from the base table.
 * @param {string} dynamoTable
 * @param {string} siteId
 * @param {string} checkId
 * @param {boolean} [consistentRead]
 * @returns {Promise<any[]>}
 */
async function queryAllCheckItems(
  dynamoTable,
  siteId,
  checkId,
  consistentRead = false,
) {
  /** @type {Record<string, unknown> | undefined} */
  let startKey;
  /** @type {any[]} */
  const items = [];

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: dynamoTable,
        ...(consistentRead ? { ConsistentRead: true } : {}),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": sitePk(siteId),
          ":prefix": checkChildrenPrefix(checkId),
        },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...(result.Items ?? []));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return items;
}

/**
 * Summarize a run's registered evidence for the CHECK header. Recorded at
 * completion so the compliance report can show how often the text path is
 * used (docs/plan-remove-places.md). Pure: takes the ART# items as read from
 * the table.
 *
 * - `photoCount`: artifacts whose `contentType` starts with "image/".
 * - `textCount`: artifacts carrying a `text` attribute and no `s3Key`.
 * - `evidenceKind`: "photos" when there is no text, "description" when there
 *   is text but no photos, "mixed" when both, "none" when neither.
 * @typedef {"photos" | "description" | "mixed" | "none"} EvidenceKind
 * @param {Array<Record<string, unknown>>} artifacts ART# items (raw table rows)
 * @returns {{ photoCount: number, textCount: number, evidenceKind: EvidenceKind }}
 */
export function evidenceSummary(artifacts) {
  let photoCount = 0;
  let textCount = 0;
  for (const it of artifacts) {
    if (
      typeof it.contentType === "string" &&
      it.contentType.startsWith("image/")
    ) {
      photoCount += 1;
    }
    if (typeof it.text === "string" && it.s3Key === undefined) {
      textCount += 1;
    }
  }
  /** @type {EvidenceKind} */
  let evidenceKind;
  if (photoCount > 0 && textCount > 0) evidenceKind = "mixed";
  else if (textCount > 0) evidenceKind = "description";
  else if (photoCount > 0) evidenceKind = "photos";
  else evidenceKind = "none";
  return { photoCount, textCount, evidenceKind };
}

/**
 * POST /v1/checks — start a perimeter run (one CHECK header per run). The
 * client mints the ULID `checkId` and sends it as the `idempotency-key` header
 * — the same idempotency contract the offline app already uses — so the write
 * is conditional on that id and an offline replay can't create a duplicate
 * header. `siteId` is derived server-side from the JWT, never from the body.
 * The body is accepted but carries nothing the header stores (a legacy
 * `places` list is ignored).
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const createCheck = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.headers["idempotency-key"];
  if (!checkId) {
    return jsonResponse(400, { error: "Missing idempotency-key header" });
  }

  try {
    readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const startedAt = new Date().toISOString();
  const item = {
    ...checkHeaderKey(siteId, checkId),
    ...checkTimelineGsi(siteId, startedAt),
    checkId,
    status: "in_progress",
    startedAt,
    issueCount: 0,
    maxSeverity: 0,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: dynamoTable,
        Item: item,
        // pk is the shared tenant partition — condition on sk (the unique part).
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    return jsonResponse(201, { checkId, status: "in_progress", startedAt });
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // Idempotent replay: the check already exists. Treat as success.
      return jsonResponse(200, { checkId, status: "in_progress" });
    }
    throw err;
  }
};

/**
 * POST /v1/checks/{checkId}/complete — close out a perimeter run: fold every
 * analyzed artifact into one scorecard (worst grade across artifacts,
 * per-category max rating) and persist the header scorecard together with the
 * evidence summary (`photoCount`, `textCount`, `evidenceKind` — see
 * `evidenceSummary`). Guidance minting is per-item at capture time
 * (photo-analysis.js → assessments:evaluate), so this response is the
 * scorecard plus those counts.
 *
 * Coverage gate: analysis is asynchronous (register → SQS → worker), so a caller
 * that completes too early would fold only the analyses that happened to land —
 * typically just the first photo. Since the header update is conditional on the
 * check not already being `completed` (idempotent-once), a premature fold would
 * freeze a partial scorecard that can never self-heal. So we refuse to finalize
 * with `409 analyzing` until EVERY registered artifact has a matching ANALYSIS#
 * item. Failed-analysis markers count toward coverage (a permanently failed photo
 * must not block the run) but are excluded from synthesis (they carry no
 * `concerns`). An already-`completed` header skips the gate so a replay stays
 * idempotent.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const completeCheck = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });

  // One query gathers the header + every child (artifacts + analyses) so we can
  // verify coverage against the registered artifacts before folding — synthesis
  // must never run over a partially-analyzed run (see the coverage gate above).
  //
  // Strongly consistent: this read is the AUTHORITATIVE coverage snapshot, and
  // the completion write is idempotent-once, so a stale eventually-consistent
  // read that missed a just-registered artifact could freeze a partial scorecard
  // that can never self-heal. ConsistentRead closes that staleness window (it's a
  // base-table query, so strong consistency is available here).
  //
  // Note: this does NOT close the check→write TOCTOU — an artifact registered
  // after this read but before the header update would still be missed. That race
  // is unreachable in the app's flow (the client registers every artifact, then
  // waits for coverage, then completes; nothing registers concurrently with
  // completion), so it's left as a documented limitation rather than guarded with
  // a transaction/registration lock.
  const items = await queryAllCheckItems(dynamoTable, siteId, checkId, true);
  const headerSk = checkHeaderKey(siteId, checkId).sk;
  const header = items.find((it) => it.sk === headerSk);
  if (!header) return jsonResponse(404, { error: "Check not found" });

  const artifactPrefix = checkArtifactPrefix(checkId);
  const analysisPrefix = checkAnalysisPrefix(checkId);
  const artifacts = items.filter((it) => it.sk.startsWith(artifactPrefix));
  const analyses = items.filter((it) => it.sk.startsWith(analysisPrefix));

  // Coverage: every registered artifact must have SOME ANALYSIS# item (analyzed
  // or failed marker). Skip when already completed so re-completion stays a
  // no-op success rather than resurrecting the gate on a closed run.
  const analyzedIds = new Set(analyses.map((it) => it.artifactId));
  const pending = artifacts.filter((it) => !analyzedIds.has(it.artifactId));
  if (header.status !== "completed" && pending.length > 0) {
    return jsonResponse(409, {
      checkId,
      status: "analyzing",
      error: "Analyses still pending; cannot complete yet",
      expected: artifacts.length,
      analyzed: analyzedIds.size,
      pending: pending.length,
    });
  }

  // Keep only the artifacts that analyzed cleanly (a "failed" marker has no
  // concerns to synthesize), and only those whose ART# row still exists — a
  // deleted artifact (DELETE /v1/checks/{id}/artifacts/{id}) leaves its
  // ANALYSIS# item behind, but its stale analysis must not reach the fold.
  const registeredIds = new Set(artifacts.map((it) => it.artifactId));
  const analyzed =
    /** @type {import("../analysis/synthesize-check.js").AnalyzedArtifact[]} */ (
      analyses
        .filter((it) => it.status === "analyzed")
        .filter((it) => registeredIds.has(it.artifactId))
        .map((it) => ({
          artifactId: it.artifactId,
          adapted: it,
        }))
    );

  const scorecard = synthesizeCheck(analyzed);
  const evidence = evidenceSummary(artifacts);

  const now = new Date().toISOString();

  /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>[number]} */
  const headerUpdate = {
    Update: {
      TableName: dynamoTable,
      Key: checkHeaderKey(siteId, checkId),
      UpdateExpression:
        "SET #status = :completed, grade = :grade, summary = :summary, categories = :categories, rubricVersion = :rubricVersion, issueCount = :issueCount, maxSeverity = :maxSeverity, photoCount = :photoCount, textCount = :textCount, evidenceKind = :evidenceKind, synthesizedAt = :now, completedAt = :now",
      // Complete exactly once: the header must exist and not already be closed.
      ConditionExpression: "attribute_exists(sk) AND #status <> :completed",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":completed": "completed",
        ":grade": scorecard.grade,
        // Analyzer-sourced one-line overall summary (see synthesizeCheck). Rides
        // along on listChecks headers so the home hub needs no detail fetch.
        ":summary": scorecard.summary,
        ":categories": scorecard.categories,
        ":rubricVersion": scorecard.rubricVersion,
        ":issueCount": scorecard.issueCount,
        ":maxSeverity": scorecard.maxSeverity,
        // Evidence mix, recorded once at completion (see evidenceSummary).
        ":photoCount": evidence.photoCount,
        ":textCount": evidence.textCount,
        ":evidenceKind": evidence.evidenceKind,
        ":now": now,
      },
    },
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [headerUpdate],
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      return jsonResponse(200, {
        checkId,
        status: "completed",
        grade: scorecard.grade,
        summary: scorecard.summary,
        issueCount: scorecard.issueCount,
        maxSeverity: scorecard.maxSeverity,
        photoCount: evidence.photoCount,
        textCount: evidence.textCount,
        evidenceKind: evidence.evidenceKind,
      });
    }
    throw err;
  }

  return jsonResponse(200, {
    checkId,
    status: "completed",
    grade: scorecard.grade,
    issueCount: scorecard.issueCount,
    maxSeverity: scorecard.maxSeverity,
    photoCount: evidence.photoCount,
    textCount: evidence.textCount,
    evidenceKind: evidence.evidenceKind,
  });
};

// Opaque pagination cursor: the DynamoDB LastEvaluatedKey round-tripped as
// base64 JSON so clients pass it back verbatim without seeing key internals.
/**
 * @param {Record<string, unknown> | undefined} key
 * @returns {string | undefined}
 */
const encodeCursor = (key) =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;

/**
 * @param {string | undefined} token
 * @returns {Record<string, unknown> | undefined}
 */
const decodeCursor = (token) => {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

/**
 * GET /v1/checks — the site's checks, newest first, over GSI1 (the sparse
 * timeline index carried only by CHECK headers, so no filtering). Supports an
 * optional `limit` and an opaque `nextToken` cursor for paging.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const listChecks = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const rawLimit = Number(event.queryStringParameters?.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : undefined;
  const startKey = decodeCursor(event.queryStringParameters?.nextToken);

  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      IndexName: GSI1_NAME,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": sitePk(siteId) },
      ScanIndexForward: false, // newest startedAt first
      ...(limit ? { Limit: limit } : {}),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );

  const nextToken = encodeCursor(result.LastEvaluatedKey);
  return jsonResponse(200, {
    checks: result.Items ?? [],
    ...(nextToken ? { nextToken } : {}),
  });
};

/**
 * GET /v1/checks/{checkId} — one check with its artifacts and analyses, read in
 * a single base-table query (`begins_with(sk, "CHECK#<id>")` gathers the header
 * and every child). 404 when the header is absent for this site.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getCheck = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });

  const items = await queryAllCheckItems(dynamoTable, siteId, checkId);
  const headerSk = checkHeaderKey(siteId, checkId).sk;
  const header = items.find((it) => it.sk === headerSk);
  if (!header) return jsonResponse(404, { error: "Check not found" });

  const artifactPrefix = checkArtifactPrefix(checkId);
  const analysisPrefix = checkAnalysisPrefix(checkId);
  return jsonResponse(200, {
    check: header,
    artifacts: items.filter((it) => it.sk.startsWith(artifactPrefix)),
    analyses: items.filter((it) => it.sk.startsWith(analysisPrefix)),
  });
};
