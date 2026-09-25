import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// S3 seam: the prefix probes during view (re)builds.
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

const { QueryError, runQuery, toQueryResponse, _test } = await import(
  "./query.js"
);
const { createViews } = await import("./lake-views.js");

/** @type {any} */
let conn;

/**
 * Seed the warm cache with empty views on a fresh connection. The cold path
 * (getWarm → installHttpfs) needs network + AWS credentials, so tests never
 * take it.
 * @param {{ empty?: string[], asOf?: string | null, refreshedAt?: number }} [opts]
 */
async function seed(opts = {}) {
  send.mockResolvedValue({ KeyCount: 0 });
  await createViews(conn, "bucket-x", { s3: { send }, install: false });
  send.mockClear();
  _test.seedWarm(conn, "bucket-x", opts);
}

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

describe("runQuery", () => {
  it("runs SQL against the views and returns JSON-safe rows plus the freshness stamp", async () => {
    await seed({ asOf: "2026-09-21T10:00:00.000Z" });
    await conn.run(`CREATE OR REPLACE VIEW checks AS
      SELECT 's1' AS siteId, 'c1' AS checkId, 'completed' AS status,
             CAST(4 AS BIGINT) AS gradeScore,
             TIMESTAMP '2026-09-20 10:00:00' AS exportedAt
      UNION ALL
      SELECT 's1', 'c2', 'completed', CAST(5 AS BIGINT),
             TIMESTAMP '2026-09-21 10:00:00'`);

    const result = await runQuery(
      "bucket-x",
      "SELECT status, count(*) AS n, max(gradeScore) AS best, max(exportedAt) AS t FROM checks GROUP BY status ORDER BY status;",
    );
    expect(result.columns).toEqual(["status", "n", "best", "t"]);
    expect(result.rows).toEqual([
      ["completed", 2, 5, "2026-09-21T10:00:00.000Z"],
    ]);
    expect(result.truncated).toBe(false);
    expect(result.asOf).toBe("2026-09-21T10:00:00.000Z");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps CTEs working inside the subquery wrapper", async () => {
    await seed();
    const result = await runQuery(
      "bucket-x",
      "WITH x AS (SELECT 1 AS n UNION ALL SELECT 2) SELECT sum(n) AS total FROM x",
    );
    expect(result.rows).toEqual([[3]]);
  });

  it("binds parameters through a prepared statement", async () => {
    await seed();
    const result = await runQuery(
      "bucket-x",
      "SELECT $siteId AS s, current_date - CAST($days AS INTEGER) < current_date AS earlier",
      { siteId: "s-9", days: 7 },
    );
    expect(result.columns).toEqual(["s", "earlier"]);
    expect(result.rows).toEqual([["s-9", true]]);
  });

  it("rejects DDL, PRAGMA, INSTALL and multi-statement input as user errors", async () => {
    await seed();
    for (const sql of [
      "CREATE TABLE t (i INT)",
      "SELECT 1; SELECT 2",
      "PRAGMA database_size",
      "INSTALL spatial",
      "SET threads = 1",
      "COPY checks TO '/tmp/x.csv'",
      "ATTACH 's3://other/db'",
    ]) {
      const err = await runQuery("bucket-x", sql).catch((e) => e);
      expect(err, sql).toBeInstanceOf(QueryError);
      expect(err.kind, sql).toBe("user");
    }
    // The user's SQL was wrong; the views are fine — cache kept.
    expect(_test.warmState()).not.toBeNull();
  });

  it("classifies a missing table as a user error and keeps the warm cache", async () => {
    await seed();
    const err = await runQuery("bucket-x", "SELECT * FROM no_such_table").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(QueryError);
    expect(err.kind).toBe("user");
    expect(err.message).toMatch(/Catalog Error/);
    expect(_test.warmState()).not.toBeNull();
  });

  it("classifies IO errors as engine errors and invalidates the warm cache", async () => {
    await seed();
    const err = await runQuery(
      "bucket-x",
      "SELECT * FROM read_parquet('/nonexistent/*.parquet')",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(QueryError);
    expect(err.kind).toBe("engine");
    expect(_test.warmState()).toBeNull();
  });

  it("caps rows with truncated: true", async () => {
    await seed();
    await conn.run(
      `CREATE OR REPLACE VIEW checks AS SELECT unnest(range(25)) AS i`,
    );
    _test.setRowCap(10);
    try {
      const result = await runQuery("bucket-x", "SELECT * FROM checks");
      expect(result.rows.length).toBe(10);
      expect(result.truncated).toBe(true);
    } finally {
      _test.setRowCap(_test.MAX_ROWS);
    }
  });

  it("survives an empty result set", async () => {
    await seed();
    const result = await runQuery(
      "bucket-x",
      "SELECT * FROM checks WHERE siteId = 'nope'",
    );
    expect(result.rows).toEqual([]);
    expect(result.columns.length).toBeGreaterThan(0);
  });
});

describe("warm refresh", () => {
  it("re-probes only the entities still on an empty stand-in view once the interval passes", async () => {
    await seed({
      empty: ["sites", "devices"],
      refreshedAt: Date.now() - _test.REFRESH_MS - 1,
    });
    send.mockResolvedValue({ KeyCount: 0 });

    await runQuery("bucket-x", "SELECT 1");

    expect(send.mock.calls.map((c) => c[0].input.Prefix)).toEqual([
      "readings/sites/",
      "readings/devices/",
    ]);
    const state = _test.warmState();
    expect([...(state?.empty ?? [])]).toEqual(["sites", "devices"]);
    expect(Date.now() - (state?.refreshedAt ?? 0)).toBeLessThan(
      _test.REFRESH_MS,
    );
  });

  it("does not probe before the interval passes", async () => {
    await seed({ empty: ["sites"] });
    await runQuery("bucket-x", "SELECT 1");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("readAsOf", () => {
  it("is null on an empty lake and the newest export stamp otherwise", async () => {
    await seed();
    expect(await _test.readAsOf(conn)).toBeNull();
    await conn.run(`CREATE OR REPLACE VIEW tasks AS
      SELECT TIMESTAMP '2026-09-22 18:00:00' AS exportedAt`);
    await conn.run(`CREATE OR REPLACE VIEW checks AS
      SELECT TIMESTAMP '2026-09-21 06:00:00' AS exportedAt`);
    expect(await _test.readAsOf(conn)).toBe("2026-09-22T18:00:00.000Z");
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
  it("passes through the result shape including asOf", () => {
    const result = {
      columns: ["a"],
      rows: [[1]],
      truncated: false,
      elapsedMs: 5,
      asOf: "2026-09-21T10:00:00.000Z",
    };
    expect(toQueryResponse(result)).toEqual(result);
  });
});
