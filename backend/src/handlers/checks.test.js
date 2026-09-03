import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Document Client so the handlers' writes hit a spy, not AWS.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { createCheck, completeCheck, listChecks, getCheck } = await import(
  "./checks.js"
);

/**
 * @param {object} opts
 * @param {string} [opts.checkId] idempotency-key header
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @param {unknown} [opts.body]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function checkEvent({ checkId, siteClaim, body }) {
  return /** @type {any} */ ({
    headers: checkId ? { "idempotency-key": checkId } : {},
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const invoke = (event) =>
  /** @type {any} */ (createCheck(event, /** @type {any} */ ({}), () => {}));

describe("createCheck", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "gnp-test-app";
  });

  it("400s without an idempotency-key", async () => {
    const res = await invoke(checkEvent({ siteClaim: "site-1" }));
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("writes the header conditionally, keyed to the derived siteId", async () => {
    send.mockResolvedValueOnce({});

    const res = await invoke(
      checkEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          places: [
            { placeId: "place-north", placeName: "North", skipped: false },
            { placeId: "place-south", placeName: "South", skipped: false },
          ],
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.TableName).toBe("gnp-test-app");
    // pk is the shared tenant partition, so idempotency conditions on sk.
    expect(cmd.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(cmd.input.Item).toMatchObject({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01",
      gsi1pk: "SITE#site-1",
      checkId: "chk_01",
      status: "in_progress",
      issueCount: 0,
      maxSeverity: 0,
      places: [
        { placeId: "place-north", placeName: "North", skipped: false },
        { placeId: "place-south", placeName: "South", skipped: false },
      ],
    });
    // gsi1sk mirrors startedAt so the timeline query sorts chronologically.
    expect(cmd.input.Item.gsi1sk).toBe(cmd.input.Item.startedAt);
  });

  it("never takes siteId from the body", async () => {
    send.mockResolvedValueOnce({});

    await invoke(
      checkEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { siteId: "evil-site" },
      }),
    );

    const cmd = send.mock.calls[0][0];
    expect(cmd.input.Item.pk).toBe("SITE#site-1");
  });

  it("treats a replayed checkId as an idempotent success", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("exists"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    const res = await invoke(
      checkEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      checkId: "chk_01",
      status: "in_progress",
    });
  });

  it("rethrows a non-conditional DynamoDB error", async () => {
    send.mockRejectedValueOnce(new Error("throughput exceeded"));
    await expect(
      invoke(checkEvent({ checkId: "chk_01", siteClaim: "site-1" })),
    ).rejects.toThrow("throughput exceeded");
  });
});

/**
 * @param {object} opts
 * @param {string} [opts.checkId] path param
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function completeEvent({ checkId, siteClaim }) {
  return /** @type {any} */ ({
    pathParameters: checkId ? { checkId } : {},
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
  });
}

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const invokeComplete = (event) =>
  /** @type {any} */ (completeCheck(event, /** @type {any} */ ({}), () => {}));

/**
 * The CHECK# header item, as the children query returns it alongside artifacts
 * and analyses.
 * @param {string} [status]
 * @returns {object}
 */
const headerItem = (status = "in_progress") => ({
  sk: "CHECK#chk_01",
  checkId: "chk_01",
  status,
});

/**
 * A registered ART# item (one per captured photo). `completeCheck` gates on
 * every one of these having a matching ANALYSIS# item.
 * @param {string} artifactId
 * @param {string} placeId
 * @param {string} placeName
 * @returns {object}
 */
const artifactItem = (artifactId, placeId, placeName = placeId) => ({
  sk: `CHECK#chk_01#ART#${placeId}#${artifactId}`,
  artifactId,
  placeId,
  placeName,
});

/**
 * @param {string} artifactId
 * @param {string} placeId
 * @param {string} placeName
 * @param {string} grade
 * @param {string} category
 * @param {number} rating
 * @returns {object}
 */
const analyzedItem = (
  artifactId,
  placeId,
  placeName,
  grade,
  category,
  rating,
) => ({
  sk: `CHECK#chk_01#ANALYSIS#${artifactId}`,
  status: "analyzed",
  artifactId,
  placeId,
  placeName,
  grade,
  gradeDescription: `${placeName} summary (${grade})`,
  rubricVersion: "1.0.0",
  concerns: [{ category, rating, explanation: "x", evidenceIndices: [] }],
});

/**
 * A permanent-failure ANALYSIS# marker: carries no concerns, but still counts
 * toward coverage so a failed photo can't block completion.
 * @param {string} artifactId
 * @returns {object}
 */
const failedItem = (artifactId) => ({
  sk: `CHECK#chk_01#ANALYSIS#${artifactId}`,
  status: "failed",
  artifactId,
  error: { code: "invalid_request", message: "bad" },
});

describe("completeCheck", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "gnp-test-app";
  });

  it("400s without a checkId", async () => {
    const res = await invokeComplete(completeEvent({ siteClaim: "site-1" }));
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("synthesizes the worst grade, writes the scorecard, and returns an assessment envelope", async () => {
    send.mockResolvedValueOnce({
      Items: [
        headerItem(),
        artifactItem("art_1", "place-north", "North"),
        artifactItem("art_2", "place-south", "South"),
        analyzedItem("art_1", "place-north", "North", "Fair", "Litter", 2),
        analyzedItem(
          "art_2",
          "place-south",
          "South",
          "Poor",
          "Hazardous Waste",
          4,
        ),
      ],
    });
    send.mockResolvedValueOnce({});

    const res = await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    // Reads this check's header + children in one query, scoped to the site.
    const q = send.mock.calls[0][0];
    expect(q).toBeInstanceOf(QueryCommand);
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(q.input.ExpressionAttributeValues[":prefix"]).toBe("CHECK#chk_01");

    const tx = send.mock.calls[1][0];
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    const items = /** @type {any[]} */ (tx.input.TransactItems);

    // Header: worst grade across places (Poor), completed exactly once.
    const header = items[0].Update;
    expect(header.Key).toEqual({ pk: "SITE#site-1", sk: "CHECK#chk_01" });
    expect(header.ConditionExpression).toBe(
      "attribute_exists(sk) AND #status <> :completed",
    );
    expect(header.ExpressionAttributeValues[":grade"]).toBe("Poor");
    // Overall summary = the worst-graded place's analyzer description (South/Poor).
    expect(header.ExpressionAttributeValues[":summary"]).toBe(
      "South summary (Poor)",
    );
    expect(header.ExpressionAttributeValues[":issueCount"]).toBe(2);
    expect(header.ExpressionAttributeValues[":maxSeverity"]).toBe(4);

    // Phase 4: complete only updates the check header. Guidance tasks are
    // created by POST /v1/assessments:evaluate from the returned envelope.
    expect(items).toHaveLength(1);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "completed",
      grade: "Poor",
      assessmentReady: true,
      assessment: {
        assessmentId: "chk_01",
        checkId: "chk_01",
        grade: "Poor",
        conditions: [
          {
            conditionId: "001-litter",
            category: "Litter",
            severity: 2,
            sourceArtifactIds: ["art_1"],
          },
          {
            conditionId: "002-hazardous-waste",
            category: "Hazardous Waste",
            severity: 4,
            sourceArtifactIds: ["art_2"],
          },
        ],
      },
    });
  });

  it("counts a failed marker toward coverage but excludes it from synthesis", async () => {
    send.mockResolvedValueOnce({
      Items: [
        headerItem(),
        artifactItem("art_1", "place-north", "North"),
        artifactItem("art_9", "place-south", "South"),
        analyzedItem("art_1", "place-north", "North", "Fair", "Litter", 2),
        // art_9 failed permanently: no grade/concerns to fold in, but its marker
        // satisfies coverage so the run isn't blocked forever.
        failedItem("art_9"),
      ],
    });
    send.mockResolvedValueOnce({});

    await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    const items = /** @type {any[]} */ (
      send.mock.calls[1][0].input.TransactItems
    );
    // Grade comes only from the analyzed artifact; no tasks are written here.
    expect(items[0].Update.ExpressionAttributeValues[":grade"]).toBe("Fair");
    expect(items).toHaveLength(1);
  });

  it("409s (no write) when a registered artifact has no analysis yet", async () => {
    // Two photos registered, only one analyzed — the classic premature-complete
    // race. Must NOT fold a partial scorecard onto the header.
    send.mockResolvedValueOnce({
      Items: [
        headerItem(),
        artifactItem("art_1", "place-north", "North"),
        artifactItem("art_2", "place-south", "South"),
        analyzedItem("art_1", "place-north", "North", "Excellent", "Litter", 0),
      ],
    });

    const res = await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      checkId: "chk_01",
      status: "analyzing",
      expected: 2,
      analyzed: 1,
      pending: 1,
    });
    // Only the read happened — no TransactWrite, so the header stays open.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("404s when the header is absent (children but no header)", async () => {
    send.mockResolvedValueOnce({
      Items: [
        artifactItem("art_1", "place-north", "North"),
        analyzedItem("art_1", "place-north", "North", "Good", "Litter", 1),
      ],
    });

    const res = await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    expect(res.statusCode).toBe(404);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("completes a check with no artifacts (null grade, empty assessment)", async () => {
    send.mockResolvedValueOnce({ Items: [headerItem()] });
    send.mockResolvedValueOnce({});

    const res = await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    const items = /** @type {any[]} */ (
      send.mock.calls[1][0].input.TransactItems
    );
    // Header-only transaction — no tasks.
    expect(items).toHaveLength(1);
    expect(items[0].Update.ExpressionAttributeValues[":grade"]).toBeNull();
    expect(items[0].Update.ExpressionAttributeValues[":summary"]).toBeNull();
    expect(JSON.parse(res.body)).toMatchObject({
      status: "completed",
      assessmentReady: true,
      assessment: { conditions: [] },
    });
  });

  it("treats a re-completed check as an idempotent success (gate skipped)", async () => {
    // Already-completed header: the coverage gate is skipped even though this
    // read shows an un-analyzed artifact, and the conditional write no-ops.
    send.mockResolvedValueOnce({
      Items: [headerItem("completed"), artifactItem("art_1", "place-north")],
    });
    send.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
      }),
    );

    const res = await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      checkId: "chk_01",
      status: "completed",
      assessmentReady: true,
      assessment: {
        assessmentId: "chk_01",
        checkId: "chk_01",
        conditions: [],
      },
    });
  });

  it("reads all DynamoDB pages before checking coverage and synthesis", async () => {
    send.mockResolvedValueOnce({
      Items: [headerItem(), artifactItem("art_1", "place-north")],
      LastEvaluatedKey: {
        pk: "SITE#site-1",
        sk: "CHECK#chk_01#ART#place-north#art_1",
      },
    });
    send.mockResolvedValueOnce({
      Items: [
        artifactItem("art_2", "place-south", "South"),
        analyzedItem("art_1", "place-north", "North", "Fair", "Litter", 2),
        analyzedItem(
          "art_2",
          "place-south",
          "South",
          "Poor",
          "Hazardous Waste",
          4,
        ),
      ],
    });
    send.mockResolvedValueOnce({});

    const res = await invokeComplete(
      completeEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );

    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01#ART#place-north#art_1",
    });
    expect(JSON.parse(res.body)).toMatchObject({
      status: "completed",
      grade: "Poor",
      issueCount: 2,
      maxSeverity: 4,
    });
  });
});

/**
 * @param {object} opts
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @param {Record<string, string>} [opts.query] queryStringParameters
 * @param {string} [opts.checkId] path param
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function readEvent({ siteClaim, query, checkId }) {
  return /** @type {any} */ ({
    ...(query ? { queryStringParameters: query } : {}),
    ...(checkId !== undefined ? { pathParameters: { checkId } } : {}),
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
  });
}

describe("listChecks", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.DYNAMO_TABLE = "gnp-test-app";
  });

  it("queries GSI1 for the site, newest-first", async () => {
    send.mockResolvedValueOnce({
      Items: [{ checkId: "chk_02" }, { checkId: "chk_01" }],
    });

    const res = await /** @type {any} */ (
      listChecks(
        readEvent({ siteClaim: "site-1" }),
        /** @type {any} */ ({}),
        () => {},
      )
    );

    expect(res.statusCode).toBe(200);
    const q = send.mock.calls[0][0];
    expect(q).toBeInstanceOf(QueryCommand);
    expect(q.input.IndexName).toBe("GSI1");
    expect(q.input.KeyConditionExpression).toBe("gsi1pk = :pk");
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(q.input.ScanIndexForward).toBe(false);
    expect(q.input.Limit).toBeUndefined();
    expect(JSON.parse(res.body).checks).toHaveLength(2);
  });

  it("passes a limit and round-trips an opaque nextToken cursor", async () => {
    const lastKey = { pk: "SITE#site-1", sk: "CHECK#chk_05" };
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });

    const res = await /** @type {any} */ (
      listChecks(
        readEvent({ siteClaim: "site-1", query: { limit: "5" } }),
        /** @type {any} */ ({}),
        () => {},
      )
    );

    const q = send.mock.calls[0][0];
    expect(q.input.Limit).toBe(5);
    const { nextToken } = JSON.parse(res.body);
    expect(nextToken).toBeTruthy();

    // Feeding the cursor back decodes to the exact LastEvaluatedKey.
    send.mockResolvedValueOnce({ Items: [] });
    await /** @type {any} */ (
      listChecks(
        readEvent({ siteClaim: "site-1", query: { nextToken } }),
        /** @type {any} */ ({}),
        () => {},
      )
    );
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(lastKey);
  });
});

describe("getCheck", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.DYNAMO_TABLE = "gnp-test-app";
  });

  it("400s without a checkId", async () => {
    const res = await /** @type {any} */ (
      getCheck(
        readEvent({ siteClaim: "site-1", checkId: "" }),
        /** @type {any} */ ({}),
        () => {},
      )
    );
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("splits the single query into header, artifacts, and analyses", async () => {
    send.mockResolvedValueOnce({
      Items: [
        { sk: "CHECK#chk_01", checkId: "chk_01", status: "in_progress" },
        { sk: "CHECK#chk_01#ART#north#art_1", artifactId: "art_1" },
        { sk: "CHECK#chk_01#ANALYSIS#art_1", status: "analyzed" },
      ],
    });

    const res = await /** @type {any} */ (
      getCheck(
        readEvent({ siteClaim: "site-1", checkId: "chk_01" }),
        /** @type {any} */ ({}),
        () => {},
      )
    );

    expect(res.statusCode).toBe(200);
    const q = send.mock.calls[0][0];
    expect(q.input.KeyConditionExpression).toBe(
      "pk = :pk AND begins_with(sk, :prefix)",
    );
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(q.input.ExpressionAttributeValues[":prefix"]).toBe("CHECK#chk_01");

    const payload = JSON.parse(res.body);
    expect(payload.check.checkId).toBe("chk_01");
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts[0].artifactId).toBe("art_1");
    expect(payload.analyses).toHaveLength(1);
    expect(payload.analyses[0].sk).toBe("CHECK#chk_01#ANALYSIS#art_1");
  });

  it("404s when the header is absent (children but no header)", async () => {
    send.mockResolvedValueOnce({
      Items: [{ sk: "CHECK#chk_01#ART#north#art_1", artifactId: "art_1" }],
    });

    const res = await /** @type {any} */ (
      getCheck(
        readEvent({ siteClaim: "site-1", checkId: "chk_01" }),
        /** @type {any} */ ({}),
        () => {},
      )
    );

    expect(res.statusCode).toBe(404);
  });
});
