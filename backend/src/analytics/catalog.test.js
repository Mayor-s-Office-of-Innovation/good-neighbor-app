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

const {
  CATALOG,
  ParamError,
  bindParams,
  getQuery,
  listCatalog,
  renderWithDefaults,
} = await import("./catalog.js");
const { createViews } = await import("./lake-views.js");
const { runQuery, _test } = await import("./query.js");

describe("CATALOG", () => {
  it("has unique ids and a description on every entry", () => {
    const ids = CATALOG.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of CATALOG) {
      expect(q.title.length, q.id).toBeGreaterThan(0);
      expect(q.description.length, q.id).toBeGreaterThan(20);
      expect(q.group.length, q.id).toBeGreaterThan(0);
    }
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

  it("gives every scheduled entry defaults for all parameters", () => {
    const scheduled = CATALOG.filter((q) => q.scheduled);
    expect(scheduled.map((q) => q.id)).toEqual([
      "compliance-by-site",
      "worst-locations",
      "open-tasks-by-site",
    ]);
    for (const q of scheduled) {
      expect(() => renderWithDefaults(q), q.id).not.toThrow();
      expect(renderWithDefaults(q), q.id).not.toMatch(/\$[a-zA-Z_]+/);
    }
  });
});

describe("every catalog query runs against the lake views", () => {
  /** @type {any} */
  let conn;

  beforeEach(async () => {
    send.mockReset();
    send.mockResolvedValue({ KeyCount: 0 });
    _test.invalidateWarm();
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await createViews(conn, "bucket-x", { s3: { send }, install: false });
    _test.seedWarm(conn, "bucket-x");
  });

  afterEach(() => {
    conn.closeSync();
  });

  it.each(CATALOG.map((q) => [q.id, q]))(
    "%s binds and executes with default parameters",
    async (_id, q) => {
      const params = bindParams(q, { siteId: "site-1" });
      const result = await runQuery("bucket-x", q.sql, params);
      expect(result.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(result.rows)).toBe(true);
    },
  );

  it("returns real rows for a query with seeded data", async () => {
    await conn.run(`CREATE OR REPLACE VIEW checks AS
      SELECT * FROM (VALUES
        ('s1', 'c1', 'completed', 'Good', CAST(4 AS BIGINT), current_date - 1, '{"evidenceKind":"photos"}'),
        ('s1', 'c2', 'completed', 'Poor', CAST(2 AS BIGINT), current_date - 1, '{"evidenceKind":"description"}'),
        ('s2', 'c3', 'in_progress', NULL, NULL, current_date, '{}')
      ) t(siteId, checkId, status, grade, gradeScore, date, raw)`);
    const q = /** @type {any} */ (getQuery("grade-distribution"));
    const result = await runQuery("bucket-x", q.sql, bindParams(q, {}));
    expect(result.columns).toEqual(["grade", "checks", "pct"]);
    expect(result.rows).toEqual([
      ["Good", 1, 50],
      ["Poor", 1, 50],
    ]);
  });
});

describe("bindParams", () => {
  const q = /** @type {any} */ (getQuery("site-recent-checks"));

  it("applies defaults and coerces numeric strings", () => {
    expect(bindParams(q, { siteId: " s-1 ", days: "30" })).toEqual({
      siteId: "s-1",
      days: 30,
    });
    expect(bindParams(q, { siteId: "s-1" })).toEqual({
      siteId: "s-1",
      days: 14,
    });
  });

  it("ignores undeclared keys and non-object input", () => {
    const withExtra = bindParams(q, { siteId: "s-1", evil: "x" });
    expect(Object.keys(withExtra)).toEqual(["siteId", "days"]);
    expect(() => bindParams(q, "nope")).toThrow(ParamError);
  });

  it("rejects missing required, non-integer, and out-of-range values", () => {
    expect(() => bindParams(q, {})).toThrow(/siteId is required/);
    expect(() => bindParams(q, { siteId: "s", days: 1.5 })).toThrow(
      /whole number/,
    );
    expect(() => bindParams(q, { siteId: "s", days: "abc" })).toThrow(
      /whole number/,
    );
    expect(() => bindParams(q, { siteId: "s", days: 0 })).toThrow(/at least 1/);
    expect(() => bindParams(q, { siteId: "s", days: 400 })).toThrow(
      /at most 365/,
    );
    expect(() => bindParams(q, { siteId: 5 })).toThrow(/must be text/);
    expect(() => bindParams(q, { siteId: "x".repeat(201) })).toThrow(
      /200 characters/,
    );
  });
});

describe("renderWithDefaults", () => {
  it("substitutes defaults as literals and escapes strings", () => {
    const rendered = renderWithDefaults({
      id: "t",
      title: "t",
      description: "t",
      group: "t",
      params: [
        { name: "days", label: "d", type: "integer", default: 7 },
        { name: "who", label: "w", type: "string", default: "O'Brien" },
      ],
      sql: "SELECT $days AS d, $who AS w WHERE $days > 0",
    });
    expect(rendered).toBe("SELECT 7 AS d, 'O''Brien' AS w WHERE 7 > 0");
  });

  it("refuses a parameter without a default", () => {
    const q = /** @type {any} */ (getQuery("site-recent-checks"));
    expect(() => renderWithDefaults(q)).toThrow(/no default/);
  });
});

describe("listCatalog", () => {
  it("serves the UI shape with SQL and a boolean scheduled flag", () => {
    const listed = listCatalog();
    expect(listed.length).toBe(CATALOG.length);
    for (const q of listed) {
      expect(Object.keys(q).sort()).toEqual([
        "description",
        "group",
        "id",
        "params",
        "scheduled",
        "sql",
        "title",
      ]);
      expect(typeof q.scheduled).toBe("boolean");
    }
  });
});
