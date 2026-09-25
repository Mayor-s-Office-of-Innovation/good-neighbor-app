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

const { createViews, runReport, scheduledReports, stripTrailingSemicolon } =
  await import("./reports.js");

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

describe("scheduledReports", () => {
  it("renders every scheduled catalog entry with literal defaults", () => {
    const reports = scheduledReports();
    expect(reports.map((r) => r.id)).toEqual([
      "compliance-by-site",
      "worst-locations",
      "open-tasks-by-site",
    ]);
    for (const r of reports) expect(r.sql, r.id).not.toMatch(/\$[a-zA-Z_]+/);
  });

  it("every scheduled report runs against an empty lake and uploads a header-only CSV", async () => {
    send.mockResolvedValue({ KeyCount: 0 });
    await createViews(conn, "bucket-x", { install: false });
    send.mockClear();
    send.mockResolvedValue({});
    for (const r of scheduledReports()) {
      const key = await runReport(conn, "bucket-x", r.id, r.sql, "2026-09-25");
      expect(key).toBe(`reports/${r.id}/2026-09-25.csv`);
    }
    const uploads = send.mock.calls.map((c) => c[0].input);
    expect(uploads.map((u) => u.Key)).toEqual([
      "reports/compliance-by-site/2026-09-25.csv",
      "reports/worst-locations/2026-09-25.csv",
      "reports/open-tasks-by-site/2026-09-25.csv",
    ]);
    for (const u of uploads) {
      expect(u.Bucket).toBe("bucket-x");
      expect(u.ContentType).toBe("text/csv");
      // Header line only: the lake is empty.
      expect(u.Body.toString("utf8").trim().split("\n").length).toBe(1);
    }
  });
});

describe("createViews (qodo #11 regression: empty lake)", () => {
  it("creates empty typed views when the lake has no files, and reports still run", async () => {
    // No entity has files: every ListObjectsV2 returns KeyCount 0.
    send.mockResolvedValue({ KeyCount: 0 });

    await createViews(conn, "bucket-x", { install: false });

    // The checks view exists and is queryable — empty but typed, so reports
    // on a truly empty lake produce a header-only CSV.
    const r = await conn.run(
      "SELECT count(*) AS n, avg(gradeScore) AS avg FROM checks",
    );
    expect(await r.getRows()).toEqual([[0n, null]]);

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
    // assert on the probe calls; the dedupe-view SQL itself is covered in
    // lake-views.test.js against a local lake.
    await expect(
      createViews(conn, "bucket-x", { install: false }),
    ).rejects.toThrow(/No files found|fetch failed|HTTP|IO Error|httpfs/i);
    expect(send.mock.calls[0][0].input.Prefix).toBe("readings/checks/");
    expect(send.mock.calls[0][0].input.Bucket).toBe("bucket-x");
  });
});
