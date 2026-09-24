import { beforeEach, describe, expect, it, vi } from "vitest";

// The handler imports analytics/query.js, which constructs a module-level
// S3Client — mock the client so the module loads, and spy on runQuery for
// handler-level assertions (the engine itself is covered in query.test.js).
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  ListObjectsV2Command: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
}));

// Handler under test + engine module (for spying on runQuery).
const { runAnalyticsQuery } = await import("./admin-analytics.js");
const queryModule = await import("../analytics/query.js");

/**
 * Build a minimal APIGatewayProxyEventV2 with Cognito-shaped authorizer claims.
 * @param {{ groups?: string | string[], body?: string }} opts
 * @returns {any} proxy event
 */
function event({ groups = "central-admin", body } = {}) {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: { jwt: { claims: { "cognito:groups": groups, sub: "admin-1" } } },
    },
    body,
  });
}

/**
 * Invoke a handler the way Lambda does (3 args) — the single-arg call in the
 * tests below is a real handler signature, not a type-level one.
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {any} evt
 * @returns {Promise<any>}
 */
function call(handler, evt) {
  return Promise.resolve(handler(evt, /** @type {any} */ ({}), () => {}));
}

/** @type {import("vitest").MockInstance} */
let runQueryMock;

beforeEach(() => {
  process.env.LAKE_BUCKET = "test-lake-bucket";
  send.mockReset();
  runQueryMock = vi
    .spyOn(queryModule, "runQuery")
    .mockResolvedValue({
      columns: ["siteId", "n"],
      rows: [["s1", 3]],
      truncated: false,
      elapsedMs: 12,
    });
});

describe("runAnalyticsQuery", () => {
  it("403s when the caller is not central-admin", async () => {
    const res = await call(runAnalyticsQuery, event({ groups: "site-staff" }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("forbidden");
    expect(runQueryMock).not.toHaveBeenCalled();
  });

  it("parses stringified JSON group lists", async () => {
    const res = await call(runAnalyticsQuery, event({ groups: '["central-admin"]' }));
    expect(res.statusCode).toBe(400); // passes the gate, fails on missing sql
    expect(JSON.parse(res.body).error).toBe("sql_required");
  });

  it("parses Cognito-style comma lists without JSON quotes", async () => {
    const res = await call(runAnalyticsQuery, event({ groups: "[central-admin,other-group]" }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("sql_required");
  });

  it("400s on missing SQL", async () => {
    const res = await call(runAnalyticsQuery, event({ body: JSON.stringify({}) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("sql_required");
  });

  it("400s on blocked SQL", async () => {
    for (const sql of [
      "INSTALL httpfs",
      "LOAD aws",
      "CREATE SECRET (TYPE S3)",
      "ATTACH 's3://other/bucket'",
      "COPY checks FROM 's3://x'",
    ]) {
      const res = await call(runAnalyticsQuery, event({ body: JSON.stringify({ sql }) }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("sql_not_allowed");
    }
    expect(runQueryMock).not.toHaveBeenCalled();
  });

  it("allows SELECT statements that contain the word COPY only as a column", async () => {
    // Sanity: the blocklist shouldn't catch innocuous queries mentioning
    // e.g. a column named "installed" — only statement-level keywords.
    const res = await call(runAnalyticsQuery, event({
        body: JSON.stringify({
          sql: "SELECT count(*) AS installed_checks FROM checks",
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("runs allowed SQL and returns the result shape", async () => {
    const res = await call(runAnalyticsQuery, event({ body: JSON.stringify({ sql: "SELECT count(*) FROM checks" }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      columns: ["siteId", "n"],
      rows: [["s1", 3]],
      truncated: false,
      elapsedMs: 12,
    });
    expect(runQueryMock).toHaveBeenCalledWith("test-lake-bucket", "SELECT count(*) FROM checks");
  });

  it("maps engine errors to 502", async () => {
    runQueryMock.mockRejectedValue(new Error("query_failed: IO Error"));
    const res = await call(runAnalyticsQuery, event({ body: JSON.stringify({ sql: "SELECT * FROM checks" }) }),
    );
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain("query_failed");
  });

  it("400s on invalid JSON body", async () => {
    const res = await call(runAnalyticsQuery, event({ body: "{not json" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_json");
  });
});