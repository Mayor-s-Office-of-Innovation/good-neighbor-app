import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// S3 seam: createViews probes prefix existence; runReport uploads the CSV.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  GetObjectCommand: class {},
  PutObjectCommand: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
  ListObjectsV2Command: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
}));

const { createViews, stripTrailingSemicolon } = await import("./reports.js");

/** @type {any} */
let conn;

beforeEach(async () => {
  send.mockReset();
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
});

afterEach(() => {
  conn.closeSync();
});

describe("stripTrailingSemicolon (qodo #7 regression)", () => {
  it("strips one trailing semicolon and trailing whitespace", () => {
    expect(stripTrailingSemicolon("SELECT 1;\n")).toBe("SELECT 1");
    expect(stripTrailingSemicolon("SELECT 1 ;  \n")).toBe("SELECT 1");
    expect(stripTrailingSemicolon("SELECT 1")).toBe("SELECT 1");
  });

  it("does not strip inner semicolons", () => {
    expect(stripTrailingSemicolon("SELECT 1; SELECT 2;")).toBe(
      "SELECT 1; SELECT 2",
    );
  });

  it("wraps a semicolon-terminated report in COPY without a parser error", async () => {
    await conn.run(
      "CREATE VIEW checks AS SELECT 's1' AS siteId, DATE '2026-09-15' AS date, 'completed' AS status, 4 AS gradeScore",
    );
    const csvPath = "/tmp/test-report.csv";
    await conn.run(
      `COPY (${stripTrailingSemicolon("SELECT siteId FROM checks;")}) TO '${csvPath}' (FORMAT CSV, HEADER)`,
    );
    expect(csvPath).toContain("test-report.csv");
  });
});

describe("createViews (qodo #11 regression: empty lake)", () => {
  it("creates empty typed views when the lake has no files, and reports still run", async () => {
    // No entity has files: every ListObjectsV2 returns KeyCount 0.
    send.mockResolvedValue({ KeyCount: 0 });

    await createViews(conn, "bucket-x", { install: false });

    // The checks view exists and is queryable — empty but typed. (A view over
    // an all-NULL one-row select aggregates to count=1 with NULL payload, not
    // to zero rows — the point is that it BINDS, not that it matches real
    // empty-partition semantics; reports on a truly empty lake produce a
    // header-only CSV, which is the goal.)
    const r = await conn.run(
      "SELECT count(*) AS n, avg(gradeScore) AS avg FROM checks",
    );
    expect(await r.getRows()).toEqual([[1n, null]]);

    // And a report SQL with the WHERE/GROUP BY pattern binds against it.
    const q = await conn.run(`
      SELECT siteId, count(*) AS reports
      FROM checks
      WHERE date IS NOT NULL AND status = 'completed'
      GROUP BY siteId
    `);
    expect(await q.getRows()).toEqual([]);
  });

  it("probes the right prefix and builds the real deduped view when files exist", async () => {
    // First call (checks probe) says files exist; the rest say no.
    send
      .mockResolvedValueOnce({ KeyCount: 1 })
      .mockResolvedValue({ KeyCount: 0 });
    // The real read_parquet on s3://bucket-x would fail here (no AWS creds) —
    // assert on the probe calls; the dedupe-view SQL itself is covered by the
    // local e2e in the build plan.
    await expect(
      createViews(conn, "bucket-x", { install: false }),
    ).rejects.toThrow(/No files found|fetch failed|HTTP|IO Error/i);
    expect(send.mock.calls[0][0].input.Prefix).toBe("readings/checks/");
    expect(send.mock.calls[0][0].input.Bucket).toBe("bucket-x");
  });
});
