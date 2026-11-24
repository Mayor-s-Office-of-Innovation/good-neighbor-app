import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  GetObjectCommand: class {},
  PutObjectCommand: class {},
  ListObjectsV2Command: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
}));

const { CATALOG, renderWithDefaults } = await import("./catalog.js");
const { createViews } = await import("./lake-views.js");

describe("CATALOG", () => {
  it("has unique ids and a description on every entry", () => {
    const ids = CATALOG.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of CATALOG)
      expect(q.description.length, q.id).toBeGreaterThan(20);
  });

  it("only references declared parameters in its SQL", () => {
    for (const q of CATALOG) {
      const used = new Set(
        [...q.sql.matchAll(/\$([a-zA-Z_]+)/g)].map((m) => m[1]),
      );
      const declared = new Set(q.params.map((p) => p.name));
      expect([...used].sort(), q.id).toEqual([...declared].sort());
    }
  });
});

describe("each report runs against the lake views as scheduled", () => {
  /** @type {any} */
  let conn;

  /**
   * Run a report with its defaults rendered in, as the report Lambda does.
   * @param {string} id
   */
  async function runReport(id) {
    const q = /** @type {any} */ (CATALOG.find((entry) => entry.id === id));
    const reader = await conn.runAndReadAll(renderWithDefaults(q));
    return {
      columns: reader.columnNames(),
      rows: reader
        .getRowsJS()
        .map((/** @type {unknown[]} */ row) =>
          row.map((v) => (typeof v === "bigint" ? Number(v) : v)),
        ),
    };
  }

  beforeEach(async () => {
    send.mockReset();
    send.mockResolvedValue({ KeyCount: 0 });
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await createViews(conn, "bucket-x", { s3: { send }, install: false });
  });

  afterEach(() => {
    conn.closeSync();
  });

  it("ranks the Site with the lowest average grade first", async () => {
    await conn.run(`CREATE OR REPLACE VIEW checks AS
      SELECT * FROM (VALUES
        ('s1', 'c1', 'completed', CAST(4 AS BIGINT), current_date - 1),
        ('s2', 'c2', 'completed', CAST(2 AS BIGINT), current_date - 1),
        ('s2', 'c3', 'completed', NULL, current_date - 1),
        ('s3', 'c4', 'completed', CAST(1 AS BIGINT), current_date - 30)
      ) t(siteId, checkId, status, gradeScore, date)`);
    const result = await runReport("worst-locations");
    // s3's check is outside the 7-day window; the ungraded check is left out.
    expect(
      result.rows.map((/** @type {unknown[]} */ row) => [
        row[result.columns.indexOf("siteId")],
        row[result.columns.indexOf("graded_checks")],
      ]),
    ).toEqual([
      ["s2", 1],
      ["s1", 1],
    ]);
  });

  it("leaves simulated filings out of open City escalations", async () => {
    await conn.run(`CREATE OR REPLACE VIEW tasks AS
      SELECT *, taskId AS shortId FROM (VALUES
        ('site', 'real', 'open', 'city_escalation', 'litter', 1, 'escalation', '2026-10-30', current_date, '{}'),
        ('site', 'sim', 'open', 'city_escalation', 'litter', 1, 'escalation', '2026-10-30', current_date, '{"deliberate311DeliveryMode":"simulated"}')
      ) t(siteId, taskId, taskStatus, type, category, severity, kind, createdAt, date, raw)`);
    const result = await runReport("open-tasks-by-site");
    expect(result.rows[0][result.columns.indexOf("open_escalations")]).toBe(1);
    expect(result.rows[0][result.columns.indexOf("open_tasks")]).toBe(2);
  });
});

describe("renderWithDefaults", () => {
  it("substitutes defaults as literals and escapes strings", () => {
    const rendered = renderWithDefaults({
      id: "t",
      description: "t",
      params: [
        { name: "days", type: "integer", default: 7 },
        { name: "who", type: "string", default: "O'Brien" },
      ],
      sql: "SELECT $days AS d, $who AS w WHERE $days > 0",
    });
    expect(rendered).toBe("SELECT 7 AS d, 'O''Brien' AS w WHERE 7 > 0");
  });
});
