import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// S3 seam: hasParquetFiles/latestPartition probes during createAllViews.
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

const { createAllViews, runQuery, toQueryResponse, _test } = await import(
  "./query.js"
);

/** @type {any} */
let conn;

beforeEach(async () => {
  send.mockReset();
  _test.invalidateWarm();
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
});

afterEach(() => {
  conn.closeSync();
});

describe("createAllViews (empty lake)", () => {
  it("creates typed views for all nine entities when nothing has files", async () => {
    send.mockResolvedValue({ KeyCount: 0 });

    await createAllViews(conn, "bucket-x", { install: false });

    // Every entity binds and queries without error (empty typed views).
    for (const entity of _test.ENTITIES) {
      const r = await conn.runAndReadAll(`SELECT count(*) AS n FROM ${entity}`);
      expect(r.getRowsJS()[0][0]).toBe(1n);
    }
  });

  it("probes the readings/<entity>/ prefix for each entity", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    expect(
      send.mock.calls.map((/** @type {any[]} */ c) => c[0].input.Prefix),
    ).toEqual(_test.ENTITIES.map((/** @type {string} */ e) => `readings/${e}/`));
  });
});

describe("runQuery", () => {
  it("runs SQL against seeded views and returns JSON-safe rows", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    // Replace one view with real data to exercise the result path.
    await conn.run(`CREATE OR REPLACE VIEW checks AS
      SELECT 's1' AS siteId, 'c1' AS checkId, 'completed' AS status,
             CAST(4 AS BIGINT) AS gradeScore,
             TIMESTAMP '2026-09-20 10:00:00' AS exportedAt
      UNION ALL
      SELECT 's1', 'c2', 'completed', CAST(5 AS BIGINT),
             TIMESTAMP '2026-09-21 10:00:00'`);
    _test.seedWarm(conn, "bucket-x", null);

    const result = await runQuery(
      "bucket-x",
      "SELECT status, count(*) AS n, max(gradeScore) AS best FROM checks GROUP BY status ORDER BY status",
    );
    expect(result.columns).toEqual(["status", "n", "best"]);
    expect(result.rows).toEqual([["completed", 2, 5]]);
    expect(result.truncated).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("converts BigInt to numbers and timestamps to ISO strings", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    await conn.run(`CREATE OR REPLACE VIEW checks AS
      SELECT TIMESTAMP '2026-09-20 10:00:00' AS exportedAt, CAST(123456789 AS BIGINT) AS gradeScore`);
    _test.seedWarm(conn, "bucket-x", null);
    const result = await runQuery("bucket-x", "SELECT * FROM checks");
    expect(result.rows[0]).toEqual(["2026-09-20T10:00:00.000Z", 123456789]);
  });

  it("throws query_failed and invalidates the warm cache on engine errors", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    _test.seedWarm(conn, "bucket-x", null);
    // A Catalog Error (not an IO/HTTP error) does NOT invalidate the warm
    // cache — the views are fine, the SQL was wrong.
    await expect(
      runQuery("bucket-x", "SELECT * FROM no_such_table"),
    ).rejects.toThrow(/query_failed/);
    expect(_test.warmState()).not.toBeNull();
  });

  it("invalidates the warm cache on IO/S3 errors", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    _test.seedWarm(conn, "bucket-x", null);
    await expect(
      runQuery("bucket-x", "SELECT * FROM read_parquet('/nonexistent/*.parquet')"),
    ).rejects.toThrow(/query_failed/);
    expect(_test.warmState()).toBeNull();
  });

  it("caps rows at MAX_ROWS with truncated: true", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    await conn.run(
      `CREATE OR REPLACE VIEW checks AS SELECT unnest(range(25)) AS i`,
    );
    _test.MAX_ROWS_SET(10);
    try {
      _test.seedWarm(conn, "bucket-x", null);
      const result = await runQuery("bucket-x", "SELECT * FROM checks");
      expect(result.rows.length).toBe(10);
      expect(result.truncated).toBe(true);
    } finally {
      _test.MAX_ROWS_SET(_test.MAX_ROWS_ORIGINAL);
    }
  });

  it("survives an empty result set", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createAllViews(conn, "bucket-x", { install: false });
    _test.seedWarm(conn, "bucket-x", null);
    const result = await runQuery(
      "bucket-x",
      "SELECT * FROM checks WHERE siteId = 'nope'",
    );
    expect(result.rows).toEqual([]);
    expect(result.columns.length).toBeGreaterThan(0);
  });
});

describe("convertValue", () => {
  it("passes through JSON-safe primitives", () => {
    expect(_test.convertValue("a")).toBe("a");
    expect(_test.convertValue(1)).toBe(1);
    expect(_test.convertValue(true)).toBe(true);
    expect(_test.convertValue(null)).toBe(null);
  });

  it("converts BigInt to Number and Date to ISO string", () => {
    expect(_test.convertValue(4n)).toBe(4);
    expect(_test.convertValue(new Date("2026-09-20T10:00:00Z"))).toBe(
      "2026-09-20T10:00:00.000Z",
    );
  });

  it("stringifies nested objects", () => {
    expect(_test.convertValue({ pk: "SITE#s1" })).toBe('{"pk":"SITE#s1"}');
  });
});

describe("toQueryResponse", () => {
  it("passes through the result shape", () => {
    expect(
      toQueryResponse({ columns: ["a"], rows: [[1]], truncated: false, elapsedMs: 5 }),
    ).toEqual({ columns: ["a"], rows: [[1]], truncated: false, elapsedMs: 5 });
  });
});