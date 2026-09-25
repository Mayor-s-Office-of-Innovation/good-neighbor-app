import { beforeEach, describe, expect, it, vi } from "vitest";

// The engine module constructs a module-level S3Client — mock the client so
// it loads without credentials, and replace runQuery with a spy (the engine
// itself is covered in analytics/query.test.js). QueryError stays real so the
// handler's classification is exercised.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  ListObjectsV2Command: class {},
}));
vi.mock("../analytics/query.js", async (importOriginal) => {
  const original = /** @type {any} */ (await importOriginal());
  return { ...original, runQuery: vi.fn() };
});

const {
  listAnalyticsQueries,
  runAnalyticsCatalogQuery,
  runAnalyticsQuery,
  MAX_SQL_LENGTH,
} = await import("./admin-analytics.js");
const { QueryError, runQuery } = await import("../analytics/query.js");
const { CATALOG, getQuery } = await import("../analytics/catalog.js");
const runQueryMock = /** @type {import("vitest").Mock} */ (
  /** @type {unknown} */ (runQuery)
);

/**
 * Build a minimal APIGatewayProxyEventV2 with Cognito-shaped authorizer claims.
 * @param {{ groups?: string | string[], body?: string, pathParameters?: Record<string, string> }} opts
 * @returns {any} proxy event
 */
function event({ groups = "central-admin", body, pathParameters } = {}) {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": groups, sub: "admin-1" } },
      },
    },
    body,
    pathParameters,
  });
}

/**
 * Invoke a handler the way Lambda does (3 args).
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {any} evt
 * @returns {Promise<any>}
 */
function call(handler, evt) {
  return Promise.resolve(handler(evt, /** @type {any} */ ({}), () => {}));
}

const RESULT = {
  columns: ["siteId", "n"],
  rows: [["s1", 3]],
  truncated: false,
  elapsedMs: 12,
  asOf: "2026-09-21T10:00:00.000Z",
};

beforeEach(() => {
  process.env.LAKE_BUCKET = "test-lake-bucket";
  runQueryMock.mockReset();
  runQueryMock.mockResolvedValue(RESULT);
});

describe("central-admin gate", () => {
  it.each([listAnalyticsQueries, runAnalyticsCatalogQuery, runAnalyticsQuery])(
    "403s when the caller is not central-admin",
    async (handler) => {
      const res = await call(
        handler,
        event({ groups: "site-staff", pathParameters: { queryId: "sites" } }),
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe("forbidden");
      expect(runQueryMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    '["central-admin"]',
    "[central-admin,other-group]",
    ["central-admin"],
  ])("accepts the central-admin group in claim shape %j", async (groups) => {
    const res = await call(listAnalyticsQueries, event({ groups }));
    expect(res.statusCode).toBe(200);
  });
});

describe("listAnalyticsQueries", () => {
  it("returns the catalog with SQL and parameter declarations", async () => {
    const res = await call(listAnalyticsQueries, event());
    expect(res.statusCode).toBe(200);
    const { queries } = JSON.parse(res.body);
    expect(queries.length).toBe(CATALOG.length);
    const recent = queries.find(
      (/** @type {any} */ q) => q.id === "site-recent-checks",
    );
    expect(recent.params.map((/** @type {any} */ p) => p.name)).toEqual([
      "siteId",
      "days",
    ]);
    expect(recent.sql).toContain("$siteId");
  });
});

describe("runAnalyticsCatalogQuery", () => {
  it("404s on an unknown query id", async () => {
    const res = await call(
      runAnalyticsCatalogQuery,
      event({ pathParameters: { queryId: "nope" } }),
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("query_not_found");
  });

  it("binds validated params and runs the catalog SQL", async () => {
    const res = await call(
      runAnalyticsCatalogQuery,
      event({
        pathParameters: { queryId: "site-recent-checks" },
        body: JSON.stringify({ params: { siteId: "s-1", days: "3" } }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(RESULT);
    expect(runQueryMock).toHaveBeenCalledWith(
      "test-lake-bucket",
      getQuery("site-recent-checks")?.sql,
      { siteId: "s-1", days: 3 },
    );
  });

  it("runs a parameterless query with an empty body", async () => {
    const res = await call(
      runAnalyticsCatalogQuery,
      event({ pathParameters: { queryId: "sites" } }),
    );
    expect(res.statusCode).toBe(200);
    expect(runQueryMock).toHaveBeenCalledWith(
      "test-lake-bucket",
      getQuery("sites")?.sql,
      {},
    );
  });

  it("400s with the reason on invalid params", async () => {
    const res = await call(
      runAnalyticsCatalogQuery,
      event({
        pathParameters: { queryId: "site-recent-checks" },
        body: JSON.stringify({ params: { days: 5 } }),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "params_invalid",
      message: "siteId is required",
    });
    expect(runQueryMock).not.toHaveBeenCalled();
  });
});

describe("runAnalyticsQuery", () => {
  it("400s on missing SQL", async () => {
    const res = await call(
      runAnalyticsQuery,
      event({ body: JSON.stringify({}) }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("sql_required");
  });

  it("400s on oversized SQL", async () => {
    const res = await call(
      runAnalyticsQuery,
      event({ body: JSON.stringify({ sql: "x".repeat(MAX_SQL_LENGTH + 1) }) }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("sql_too_long");
    expect(runQueryMock).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON body", async () => {
    const res = await call(runAnalyticsQuery, event({ body: "{not json" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_json");
  });

  it("runs the SQL against the lake bucket and returns the result shape", async () => {
    const res = await call(
      runAnalyticsQuery,
      event({ body: JSON.stringify({ sql: " SELECT count(*) FROM checks " }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(RESULT);
    expect(runQueryMock).toHaveBeenCalledWith(
      "test-lake-bucket",
      "SELECT count(*) FROM checks",
    );
  });

  it("echoes user SQL errors back as 400 so the admin can fix the statement", async () => {
    runQueryMock.mockRejectedValue(
      new QueryError("user", 'Parser Error: syntax error at or near "FORM"'),
    );
    const res = await call(
      runAnalyticsQuery,
      event({ body: JSON.stringify({ sql: "SELECT * FORM checks" }) }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "sql_invalid",
      message: 'Parser Error: syntax error at or near "FORM"',
    });
  });

  it("maps engine errors to a generic 502 without the engine message", async () => {
    for (const err of [
      new QueryError(
        "engine",
        "IO Error: s3://test-lake-bucket/readings/… 403",
      ),
      new Error("Missing required environment variable for LAKE_BUCKET"),
    ]) {
      runQueryMock.mockRejectedValue(err);
      const res = await call(
        runAnalyticsQuery,
        event({ body: JSON.stringify({ sql: "SELECT * FROM checks" }) }),
      );
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body)).toEqual({ error: "query_failed" });
      expect(res.body).not.toContain("test-lake-bucket");
    }
  });
});
