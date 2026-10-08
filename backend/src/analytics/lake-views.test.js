import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  GetObjectCommand: class {},
  PutObjectCommand: class {},
  ListObjectsV2Command: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
}));

const {
  ENTITIES,
  createViews,
  emptyViewSql,
  lakeViewSql,
  lockdown,
  stripTrailingSemicolon,
} = await import("./lake-views.js");
const { ENTITY_COLUMNS } = await import("./convert.js");

/** @type {any} */
let db;
/** @type {any} */
let conn;

beforeEach(async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
});

afterEach(() => {
  conn.closeSync();
});

/**
 * @param {string} sql
 * @returns {Promise<any[][]>}
 */
async function rows(sql) {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowsJS();
}

describe("ENTITIES", () => {
  it("is exactly the converter's entity set, in converter order", () => {
    expect(ENTITIES).toEqual(Object.keys(ENTITY_COLUMNS));
    expect(ENTITIES).toContain("sites");
    expect(ENTITIES).toContain("providers");
    expect(ENTITIES).toContain("devices");
  });
});

describe("emptyViewSql", () => {
  it("exposes the converter's columns plus a DATE partition column, with zero rows", async () => {
    for (const entity of ENTITIES) {
      await conn.run(emptyViewSql(entity));
      const described = await rows(`DESCRIBE ${entity}`);
      expect(described.map((r) => r[0])).toEqual([
        ...ENTITY_COLUMNS[entity],
        "date",
      ]);
      const types = Object.fromEntries(described.map((r) => [r[0], r[1]]));
      expect(types.date).toBe("DATE");
      expect(types.exportedAt).toBe("TIMESTAMP");
      expect(types.raw).toBe("VARCHAR");
      expect(await rows(`SELECT count(*) FROM ${entity}`)).toEqual([[0n]]);
    }
  });

  it("rejects an unknown entity", () => {
    expect(() => emptyViewSql("receipts")).toThrow(/unknown lake entity/);
  });
});

describe("lakeViewSql over a local lake", () => {
  /** @type {string} */
  let lake;

  beforeEach(async () => {
    lake = mkdtempSync(join(tmpdir(), "gn-lake-"));
    const write = async (
      /** @type {string} */ partition,
      /** @type {string} */ file,
      /** @type {string} */ select,
    ) => {
      const dir = join(lake, "checks", `date=${partition}`);
      mkdirSync(dir, { recursive: true });
      await conn.run(
        `COPY (${select}) TO '${join(dir, file)}' (FORMAT PARQUET)`,
      );
    };
    const row = (
      /** @type {string} */ checkId,
      /** @type {number} */ grade,
      /** @type {string} */ exportedAt,
    ) =>
      `SELECT 's1' AS siteId, '${checkId}' AS checkId, 'completed' AS status,
              CAST(${grade} AS BIGINT) AS gradeScore,
              TIMESTAMP '${exportedAt}' AS exportedAt,
              '{"pk":"SITE#s1","sk":"CHECK#${checkId}"}' AS raw`;
    // Same key exported twice: the later export must win.
    await write(
      "2026-09-20",
      "part-export-a.parquet",
      row("c1", 3, "2026-09-20 06:00:00"),
    );
    await write(
      "2026-09-20",
      "part-export-b.parquet",
      row("c1", 5, "2026-09-20 12:00:00"),
    );
    await write(
      "2026-09-21",
      "part-export-b.parquet",
      row("c2", 4, "2026-09-20 12:00:00"),
    );
    // A row the converter couldn't date: must not break the date column.
    await write(
      "unknown",
      "part-export-b.parquet",
      row("c3", 2, "2026-09-20 12:00:00"),
    );
  });

  afterEach(() => {
    rmSync(lake, { recursive: true, force: true });
  });

  it("dedupes latest-wins per (pk, sk) and keeps date a DATE despite an unknown partition", async () => {
    await conn.run(lakeViewSql(lake, "checks"));
    const described = await rows("DESCRIBE checks");
    const types = Object.fromEntries(described.map((r) => [r[0], r[1]]));
    expect(types.date).toBe("DATE");
    expect(described.map((r) => r[0])).not.toContain("pk");

    const all = await rows(
      "SELECT checkId, gradeScore, date FROM checks ORDER BY checkId",
    );
    expect(all).toEqual([
      ["c1", 5n, new Date("2026-09-20T00:00:00.000Z")],
      ["c2", 4n, new Date("2026-09-21T00:00:00.000Z")],
      ["c3", 2n, null],
    ]);

    // The whole point of the cast: date filters keep working.
    expect(
      await rows("SELECT count(*) FROM checks WHERE date >= DATE '2026-09-21'"),
    ).toEqual([[1n]]);
  });

  it("picks up files added after the view was created (no rebuild needed)", async () => {
    await conn.run(lakeViewSql(lake, "checks"));
    expect(await rows("SELECT count(*) FROM checks")).toEqual([[3n]]);
    const dir = join(lake, "checks", "date=2026-09-22");
    mkdirSync(dir, { recursive: true });
    await conn.run(
      `COPY (SELECT 's1' AS siteId, 'c4' AS checkId, TIMESTAMP '2026-09-22 00:00:00' AS exportedAt,
                    '{"pk":"SITE#s1","sk":"CHECK#c4"}' AS raw)
       TO '${join(dir, "part-export-c.parquet")}' (FORMAT PARQUET)`,
    );
    expect(await rows("SELECT count(*) FROM checks")).toEqual([[4n]]);
  });
});

describe("createViews", () => {
  it("builds an empty stand-in for every entity without files and reports them", async () => {
    const send = vi.fn().mockResolvedValue({ KeyCount: 0 });
    const result = await createViews(conn, "bucket-x", {
      s3: { send },
      install: false,
    });
    expect(result.empty).toEqual(ENTITIES);
    expect(send.mock.calls.map((c) => c[0].input.Prefix)).toEqual(
      ENTITIES.map((e) => `readings/${e}/`),
    );
    expect(send.mock.calls[0][0].input.Bucket).toBe("bucket-x");
    for (const entity of ENTITIES) {
      expect(await rows(`SELECT count(*) FROM ${entity}`)).toEqual([[0n]]);
    }
  });

  it("probes only the requested entities", async () => {
    const send = vi.fn().mockResolvedValue({ KeyCount: 0 });
    const result = await createViews(conn, "bucket-x", {
      s3: { send },
      install: false,
      entities: ["sites", "devices"],
    });
    expect(result.empty).toEqual(["sites", "devices"]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("requires an s3 client", async () => {
    await expect(
      createViews(conn, "bucket-x", /** @type {any} */ ({ install: false })),
    ).rejects.toThrow(/s3 client/);
  });
});

describe("lockdown", () => {
  it("blocks local filesystem reads and configuration changes on every connection, but still allows views", async () => {
    await lockdown(conn);
    await expect(
      conn.run("SELECT content FROM read_text('/etc/hosts')"),
    ).rejects.toThrow(/LocalFileSystem has been disabled/);
    await expect(conn.run("SET threads = 1")).rejects.toThrow(/locked/);
    await expect(
      conn.run("SET GLOBAL disabled_filesystems = ''"),
    ).rejects.toThrow(/locked/);

    // A second connection on the same instance is locked too.
    const other = await db.connect();
    try {
      await expect(
        other.run("SELECT content FROM read_text('/etc/hosts')"),
      ).rejects.toThrow(/LocalFileSystem has been disabled/);
      await other.run("CREATE OR REPLACE VIEW v AS SELECT 1 AS x");
    } finally {
      other.closeSync();
    }
    expect(await rows("SELECT x FROM v")).toEqual([[1]]);
  });
});

describe("stripTrailingSemicolon", () => {
  it("strips one trailing semicolon and trailing whitespace only", () => {
    expect(stripTrailingSemicolon("SELECT 1;\n")).toBe("SELECT 1");
    expect(stripTrailingSemicolon("SELECT 1 ;  \n")).toBe("SELECT 1");
    expect(stripTrailingSemicolon("SELECT 1")).toBe("SELECT 1");
    expect(stripTrailingSemicolon("SELECT 1; SELECT 2;")).toBe(
      "SELECT 1; SELECT 2",
    );
  });
});
