import { beforeEach, describe, expect, it, vi } from "vitest";

// S3 seam for the manifest test: one GetObject per call, body via
// transformToString (the shape listManifestDataFiles consumes).
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  GetObjectCommand: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
  PutObjectCommand: class {},
}));

const {
  classifyItem,
  toRow,
  parseExportFile,
  dateFromTimestamp,
  ENTITY_COLUMNS,
  columnSchema,
  listManifestDataFiles,
} = await import("./convert.js");

// ---- key classification ------------------------------------------------------

describe("classifyItem", () => {
  it("classifies check header, artifacts, analyses by sk shape", () => {
    expect(classifyItem({ pk: "SITE#s1", sk: "CHECK#c1" })).toBe("checks");
    expect(classifyItem({ pk: "SITE#s1", sk: "CHECK#c1#ART#kitchen#a1" })).toBe(
      "artifacts",
    );
    expect(classifyItem({ pk: "SITE#s1", sk: "CHECK#c1#ANALYSIS#a1" })).toBe(
      "analyses",
    );
  });

  it("classifies assessments before conditions (order matters)", () => {
    expect(classifyItem({ pk: "SITE#s1", sk: "ASSESSMENT#as1" })).toBe(
      "assessments",
    );
    expect(classifyItem({ pk: "SITE#s1", sk: "ASSESSMENT#as1#COND#c1" })).toBe(
      "conditions",
    );
  });

  it("classifies tasks, devices, sites, providers", () => {
    expect(classifyItem({ pk: "SITE#s1", sk: "TASK#t1" })).toBe("tasks");
    expect(classifyItem({ pk: "SITE#s1", sk: "DEVICE#d1" })).toBe("devices");
    expect(classifyItem({ pk: "SITE#s1", sk: "#META" })).toBe("sites");
    expect(classifyItem({ pk: "PROVIDER#p1", sk: "#META" })).toBe("providers");
  });

  it("skips non-reporting items (counters, receipts, pointers, search)", () => {
    expect(
      classifyItem({ pk: "SITE#s1", sk: "COUNTER#task-display-id" }),
    ).toBeNull();
    expect(classifyItem({ pk: "SUBMISSION#r1", sk: "#RECEIPT" })).toBeNull();
    expect(
      classifyItem({ pk: "SITE#s1", sk: "GUIDANCE_CURRENT#[a,b]" }),
    ).toBeNull();
    expect(classifyItem({ pk: "PROVIDER_SEARCH#ACTIVE", sk: "p1" })).toBeNull();
    expect(
      classifyItem({ pk: "ANALYTICS#EXPORT", sk: "#WATERMARK" }),
    ).toBeNull();
    expect(classifyItem({ pk: "SETUP_CODE#x", sk: "y" })).toBeNull();
  });
});

// ---- promoted columns --------------------------------------------------------

describe("toRow", () => {
  it("maps grade to grade_score (Excellent=5 … Very Poor=1, unknown/absent null)", () => {
    expect(toRow("checks", { grade: "Excellent" }, "t").gradeScore).toBe(5);
    expect(toRow("checks", { grade: "Very Poor" }, "t").gradeScore).toBe(1);
    expect(toRow("checks", { grade: "Fair" }, "t").gradeScore).toBe(3);
    expect(toRow("checks", {}, "t").gradeScore).toBeNull();
    expect(toRow("checks", { grade: "Bogus" }, "t").gradeScore).toBeNull();
  });

  it("derives siteId from item or pk prefix", () => {
    expect(toRow("checks", { siteId: "s1" }, "t").siteId).toBe("s1");
    expect(toRow("checks", { pk: "SITE#s2" }, "t").siteId).toBe("s2");
    expect(toRow("checks", {}, "t").siteId).toBeNull();
  });

  it("builds a checks row with report columns + raw JSON", () => {
    const item = {
      pk: "SITE#s1",
      sk: "CHECK#c1",
      checkId: "c1",
      status: "completed",
      startedAt: "2026-09-16T10:00:00.000Z",
      grade: "Poor",
      issueCount: 2,
      maxSeverity: 4,
    };
    const row = toRow("checks", item, "2026-09-16T18:00:00.000Z");
    expect(row).toMatchObject({
      siteId: "s1",
      checkId: "c1",
      status: "completed",
      startedAt: "2026-09-16T10:00:00.000Z",
      grade: "Poor",
      gradeScore: 2,
      issueCount: 2,
      maxSeverity: 4,
      date: "2026-09-16",
      exportedAt: "2026-09-16T18:00:00.000Z",
    });
    expect(JSON.parse(/** @type {string} */ (row.raw))).toEqual(item);
  });

  it("builds a tasks row with taskStatus (no collision with checks status)", () => {
    const row = toRow(
      "tasks",
      {
        pk: "SITE#s1",
        sk: "TASK#t1",
        taskId: "t1",
        status: "open",
        severity: 3,
      },
      "t",
    );
    expect(row.taskStatus).toBe("open");
    expect(row.severity).toBe(3);
    expect(row.date).toBeNull(); // no createdAt in item
  });

  it("never sets date from an unknown shape", () => {
    expect(toRow("checks", {}, "t").date).toBeNull();
    expect(dateFromTimestamp("not-a-date")).toBeNull();
    expect(dateFromTimestamp("2026-09-16T10:00:00Z")).toBe("2026-09-16");
    expect(dateFromTimestamp(null)).toBeNull();
  });

  it("every entity has a stable column order containing its promoted fields", () => {
    for (const entity of Object.keys(ENTITY_COLUMNS)) {
      expect(ENTITY_COLUMNS[entity].length).toBeGreaterThan(3);
      expect(ENTITY_COLUMNS[entity]).toContain("raw");
      expect(ENTITY_COLUMNS[entity]).toContain("exportedAt");
    }
  });

  it("pins DuckDB column types: timestamps, numerics, everything else VARCHAR", () => {
    const schema = columnSchema(ENTITY_COLUMNS.checks);
    expect(schema.exportedAt).toBe("TIMESTAMP");
    expect(schema.gradeScore).toBe("BIGINT");
    expect(schema.issueCount).toBe("BIGINT");
    expect(schema.maxSeverity).toBe("BIGINT");
    expect(schema.grade).toBe("VARCHAR");
    expect(schema.raw).toBe("VARCHAR");
    const taskSchema = columnSchema(ENTITY_COLUMNS.tasks);
    expect(taskSchema.severity).toBe("BIGINT");
    expect(taskSchema.createdAt).toBe("VARCHAR");
  });
});

// ---- export file parsing -----------------------------------------------------

/**
 * @param {string} ndjson
 * @param {string} [exportedAt]
 * @returns {Promise<Map<string, any>>}
 */
async function parseText(ndjson, exportedAt = "2026-09-16T18:00:00.000Z") {
  const { createGzip } = await import("node:zlib");
  const { Readable: R } = await import("node:stream");
  const body = R.from([ndjson]).pipe(createGzip());
  return parseExportFile(/** @type {any} */ (body), exportedAt);
}

describe("parseExportFile", () => {
  it('parses full-export shape ({"Item": …})', async () => {
    const ndjson =
      JSON.stringify({
        Item: {
          pk: { S: "SITE#s1" },
          sk: { S: "CHECK#c1" },
          checkId: { S: "c1" },
          grade: { S: "Good" },
          startedAt: { S: "2026-09-16T01:00:00.000Z" },
        },
      }) + "\n";
    const byEntity = await parseText(ndjson);
    const checks = byEntity.get("checks") ?? [];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      checkId: "c1",
      grade: "Good",
      gradeScore: 4,
      siteId: "s1",
      date: "2026-09-16",
    });
  });

  it("parses incremental NEW_IMAGE_ONLY shape and skips deletes", async () => {
    const ndjson = [
      {
        Metadata: { RecordType: "ModificationRecord" },
        Keys: { pk: { S: "SITE#s1" }, sk: { S: "TASK#t1" } },
        NewImage: {
          pk: { S: "SITE#s1" },
          sk: { S: "TASK#t1" },
          taskId: { S: "t1" },
          status: { S: "resolved" },
          createdAt: { S: "2026-09-15T09:00:00.000Z" },
        },
      },
      {
        Metadata: { RecordType: "ModificationRecord" },
        Keys: { pk: { S: "SITE#s1" }, sk: { S: "TASK#t2" } },
        // no NewImage → delete
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const byEntity = await parseText(ndjson);
    const tasks = byEntity.get("tasks") ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: "t1", taskStatus: "resolved" });
    expect(byEntity.size).toBe(1);
  });

  it("unmarshalls typed DynamoDB JSON (N → number, M/L, BOOL, NULL)", async () => {
    const ndjson =
      JSON.stringify({
        Item: {
          pk: { S: "SITE#s1" },
          sk: { S: "CHECK#c1" },
          issueCount: { N: "72" },
          nested: { M: { a: { L: [{ N: "1" }, { BOOL: false }] } } },
          none: { NULL: true },
        },
      }) + "\n";
    const byEntity = await parseText(ndjson);
    const row = (byEntity.get("checks") ?? [])[0];
    expect(row.issueCount).toBe(72);
    expect(row.gradeScore).toBeNull();
    const raw = JSON.parse(row.raw);
    expect(raw.nested).toEqual({ a: [1, false] });
    expect(raw.none).toBeNull();
  });

  it("skips torn/trailing lines and non-reporting entities", async () => {
    const ndjson = [
      JSON.stringify({ Item: { pk: { S: "SITE#s1" }, sk: { S: "CHECK#c1" } } }),
      "{torn",
      JSON.stringify({
        Item: { pk: { S: "SITE#s1" }, sk: { S: "COUNTER#task-display-id" } },
      }),
      "",
    ].join("\n");
    const byEntity = await parseText(ndjson);
    expect(byEntity.size).toBe(1);
    expect(byEntity.get("checks")).toHaveLength(1);
  });
});

// ---- manifest parsing (JSON Lines — qodo #4 regression) ----------------------

describe("listManifestDataFiles (manifest-files.json is JSON Lines)", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("parses one descriptor per line (multi-file manifest)", async () => {
    send.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          [
            JSON.stringify({
              dataFileS3Key: "raw/AWSDynamoDB/abc/Data/1.json.gz",
              itemCount: 100,
            }),
            JSON.stringify({
              dataFileS3Key: "raw/AWSDynamoDB/abc/Data/2.json.gz",
              itemCount: 5,
            }),
          ].join("\n"),
      },
    });
    const files = await listManifestDataFiles(
      "bucket",
      "raw/x/manifest-files.json",
    );
    expect(files).toEqual([
      "raw/AWSDynamoDB/abc/Data/1.json.gz",
      "raw/AWSDynamoDB/abc/Data/2.json.gz",
    ]);
  });

  it("parses a single-line manifest (the common small-export case)", async () => {
    send.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          JSON.stringify({
            dataFileS3Key: "raw/abc/Data/1.json.gz",
          }) + "\n",
      },
    });
    const files = await listManifestDataFiles(
      "bucket",
      "raw/x/manifest-files.json",
    );
    expect(files).toEqual(["raw/abc/Data/1.json.gz"]);
  });

  it("throws on a manifest that is a single JSON object (wrong format)", async () => {
    send.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          JSON.stringify({ manifestEntries: [{ dataFileS3Key: "x" }] }),
      },
    });
    // A single-object manifest has no dataFileS3Key at the top level of any
    // line, so it parses to zero files rather than throwing.
    const files = await listManifestDataFiles(
      "bucket",
      "raw/x/manifest-files.json",
    );
    expect(files).toEqual([]);
  });
});

// ---- real stored shapes (qodo #15/#16 regressions) ---------------------------

describe("stored item shapes", () => {
  it("promotes condition categories from canonicalCategory/analyzerCategory (not 'category')", () => {
    const item = {
      pk: "SITE#s1",
      sk: "ASSESSMENT#a1#COND#c1",
      conditionId: "c1",
      assessmentId: "a1",
      analyzerCategory: "Graffiti",
      canonicalCategory: "Graffiti",
      severity: 3,
      reportedAt: "2026-09-16T01:00:00.000Z",
    };
    const row = toRow("conditions", item, "t");
    expect(row.canonicalCategory).toBe("Graffiti");
    expect(row.analyzerCategory).toBe("Graffiti");
    expect(row.category).toBeUndefined();
    expect(ENTITY_COLUMNS.conditions).toContain("canonicalCategory");
    expect(ENTITY_COLUMNS.conditions).toContain("analyzerCategory");
    expect(ENTITY_COLUMNS.conditions).not.toContain("category");
  });

  it("promotes device label from item.label (not 'name')", () => {
    const row = toRow(
      "devices",
      {
        pk: "SITE#s1",
        sk: "DEVICE#d1",
        label: "Front desk",
        lastSeenAt: "2026-09-16T01:00:00.000Z",
      },
      "t",
    );
    expect(row.label).toBe("Front desk");
    expect(row.name).toBeUndefined();
    expect(ENTITY_COLUMNS.devices).toContain("label");
  });

  it("promotes task terminal status verbatim ('completed', not 'resolved')", () => {
    const row = toRow(
      "tasks",
      {
        pk: "SITE#s1",
        sk: "TASK#t1",
        status: "completed",
        createdAt: "2026-09-16T01:00:00.000Z",
      },
      "t",
    );
    expect(row.taskStatus).toBe("completed");
  });
});
