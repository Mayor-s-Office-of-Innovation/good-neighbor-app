// DynamoDB export JSON → entity-split Parquet (ADR 0013 Phase 3).
//
// Trigger: manifest-summary.json landing under raw/ in the lake bucket. This
// module resolves the export's manifest, streams each gzipped NDJSON data file,
// unmarshals DynamoDB typed JSON, classifies each item by its sk prefix into an
// entity, and writes one Parquet file per (entity, date) partition with the
// export ID in the file name — so re-running the same export overwrites rather
// than duplicates (idempotency by construction).
//
// Rows carry the promoted report columns as top-level typed columns plus the
// full item as a raw JSON column (nothing lost) and an exported_at stamp for
// latest-wins dedupe ordering (the view's QUALIFY clause).
//
// Entity sets differ (checks/tasks/conditions/assessments/artifacts/analyses),
// so each entity gets its own Parquet path: readings/<entity>/date=YYYY-MM-DD/.
// Partition date is the item's own event date (startedAt/createdAt/reportedAt),
// so a late-arriving export lands rows in the correct day.

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DuckDBInstance } from "@duckdb/node-api";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const s3 = new S3Client({});

// Grade score mapping (ADR 0013 §6): Excellent=5 … Very Poor=1, null when
// absent. Mirrors GRADE_ORDER in synthesize-check.js (worst-first there,
// best-first here for the score).
/** @type {Record<string, number>} */
const GRADE_SCORE = {
  Excellent: 5,
  Good: 4,
  Fair: 3,
  Poor: 2,
  "Very Poor": 1,
};

// Entities recognized by key shape; see classifyItem(). Anything unrecognized
// (receipts, counters, pointers, PROVIDER_SEARCH, setup-code items) is
// skipped — only reporting entities reach the lake.

/**
 * Classify one item by its key shape into an entity name, or null to skip.
 * Order matters: ASSESSMENT#x#COND#y must match before the bare ASSESSMENT#
 * header rule, and CHECK#x#ART#…/#ANALYSIS#… before the CHECK# header rule.
 * @param {{ pk: string, sk: string }} key
 * @returns {string | null}
 */
export function classifyItem({ pk, sk }) {
  if (pk.startsWith("PROVIDER#") && sk === "#META") return "providers";
  if (pk.startsWith("SITE#")) {
    if (sk === "#META") return "sites";
    if (sk.startsWith("CHECK#")) {
      if (sk.includes("#ART#")) return "artifacts";
      if (sk.includes("#ANALYSIS#")) return "analyses";
      return "checks";
    }
    if (sk.startsWith("ASSESSMENT#")) {
      if (sk.includes("#COND#")) return "conditions";
      return "assessments";
    }
    if (sk.startsWith("TASK#")) return "tasks";
    if (sk.startsWith("DEVICE#")) return "devices";
  }
  return null;
}

/**
 * Promote the report columns for one entity (ADR 0013 §Decision 2: top-level
 * typed columns per entity; everything else stays in the raw JSON column).
 * @param {string} entity
 * @param {Record<string, unknown>} item already unmarshalled
 * @param {string} exportedAt ISO stamp of the export run
 * @returns {Record<string, unknown>} flat row (includes raw + exportedAt)
 */
export function toRow(entity, item, exportedAt) {
  const row = {
    siteId: str(item.siteId) ?? siteIdFromPk(item.pk),
    gradeScore: gradeScore(item.grade),
    exportedAt,
    raw: JSON.stringify(item),
  };
  switch (entity) {
    case "checks": {
      Object.assign(row, {
        checkId: str(item.checkId),
        status: str(item.status),
        startedAt: str(item.startedAt),
        completedAt: str(item.completedAt),
        grade: str(item.grade),
        issueCount: num(item.issueCount),
        maxSeverity: num(item.maxSeverity),
        synthesizedAt: str(item.synthesizedAt),
        date: dateFromTimestamp(str(item.startedAt)),
      });
      break;
    }
    case "tasks": {
      Object.assign(row, {
        taskId: str(item.taskId),
        shortId: str(item.shortId),
        type: str(item.type),
        kind: str(item.kind),
        category: str(item.category),
        severity: num(item.severity),
        taskStatus: str(item.status),
        createdAt: str(item.createdAt),
        resolvedAt: str(item.resolvedAt),
        date: dateFromTimestamp(str(item.createdAt)),
      });
      break;
    }
    case "conditions": {
      Object.assign(row, {
        assessmentId: str(item.assessmentId),
        conditionId: str(item.conditionId),
        // Condition items carry the analyzer's raw label and the app's
        // canonical one (guidance-store.js) — 'category' does not exist.
        canonicalCategory: str(item.canonicalCategory),
        analyzerCategory: str(item.analyzerCategory),
        severity: num(item.severity),
        outcome: str(item.outcome),
        conditionStatus: str(item.status),
        reportedAt: str(item.reportedAt),
        date: dateFromTimestamp(str(item.reportedAt)),
      });
      break;
    }
    case "assessments": {
      Object.assign(row, {
        assessmentId: str(item.assessmentId),
        policyVersion: str(item.policyVersion),
        grade: str(item.grade),
        reportedAt: str(item.reportedAt),
        date: dateFromTimestamp(str(item.reportedAt)),
      });
      break;
    }
    case "artifacts": {
      Object.assign(row, {
        checkId: str(item.checkId),
        artifactId: str(item.artifactId),
        placeId: str(item.placeId),
        placeName: str(item.placeName),
        capturedAt: str(item.capturedAt),
        date: dateFromTimestamp(str(item.capturedAt)),
      });
      break;
    }
    case "analyses": {
      Object.assign(row, {
        checkId: str(item.checkId),
        artifactId: str(item.artifactId),
        analysisStatus: str(item.status),
        analyzedAt: str(item.analyzedAt),
        date: dateFromTimestamp(str(item.analyzedAt)),
      });
      break;
    }
    case "sites":
    case "providers": {
      Object.assign(row, {
        name: str(item.name),
        updatedAt: str(item.updatedAt ?? item.lastSeenAt),
        date: dateFromTimestamp(str(item.updatedAt ?? item.lastSeenAt)),
      });
      break;
    }
    case "devices": {
      // Device items carry `label`, not `name` (handlers/devices.js).
      Object.assign(row, {
        label: str(item.label),
        updatedAt: str(item.lastSeenAt),
        date: dateFromTimestamp(str(item.lastSeenAt)),
      });
      break;
    }
  }
  return row;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  return typeof v === "string" ? v : null;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function gradeScore(v) {
  if (typeof v !== "string") return null;
  const score = GRADE_SCORE[v];
  return typeof score === "number" ? score : null;
}

/**
 * Derive the partition date (YYYY-MM-DD) from an item's own event timestamp.
 * @param {string | null} iso
 * @returns {string | null}
 */
export function dateFromTimestamp(iso) {
  if (!iso) return null;
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * @param {unknown} pk
 * @returns {string | null}
 */
function siteIdFromPk(pk) {
  if (typeof pk !== "string") return null;
  return pk.startsWith("SITE#") ? pk.slice(5) : null;
}

// Column order per entity — Parquet needs a stable schema per file set.
/** @type {Record<string, string[]>} */
export const ENTITY_COLUMNS = {
  checks: [
    "siteId",
    "checkId",
    "status",
    "startedAt",
    "completedAt",
    "grade",
    "gradeScore",
    "issueCount",
    "maxSeverity",
    "synthesizedAt",
    "exportedAt",
    "raw",
  ],
  tasks: [
    "siteId",
    "taskId",
    "shortId",
    "type",
    "kind",
    "category",
    "severity",
    "taskStatus",
    "createdAt",
    "resolvedAt",
    "exportedAt",
    "raw",
  ],
  conditions: [
    "siteId",
    "assessmentId",
    "conditionId",
    "canonicalCategory",
    "analyzerCategory",
    "severity",
    "outcome",
    "conditionStatus",
    "reportedAt",
    "exportedAt",
    "raw",
  ],
  assessments: [
    "siteId",
    "assessmentId",
    "policyVersion",
    "grade",
    "gradeScore",
    "reportedAt",
    "exportedAt",
    "raw",
  ],
  artifacts: [
    "siteId",
    "checkId",
    "artifactId",
    "placeId",
    "placeName",
    "capturedAt",
    "exportedAt",
    "raw",
  ],
  analyses: [
    "siteId",
    "checkId",
    "artifactId",
    "analysisStatus",
    "gradeScore",
    "analyzedAt",
    "exportedAt",
    "raw",
  ],
  sites: ["siteId", "name", "updatedAt", "exportedAt", "raw"],
  providers: ["siteId", "name", "updatedAt", "exportedAt", "raw"],
  devices: ["siteId", "label", "updatedAt", "exportedAt", "raw"],
};

/**
 * DuckDB `columns` spec for the promoted columns: the exportedAt stamp is a
 * real timestamp, grade/severity/count columns are numeric, everything else
 * VARCHAR (raw JSON column included — it's read with `raw->>'$.pk'`, which
 * takes a VARCHAR, not a JSON type).
 * @param {string[]} columns
 * @returns {Record<string, string>}
 */
export function columnSchema(columns) {
  const tsColumns = new Set(["exportedAt"]);
  const numeric = new Set([
    "gradeScore",
    "issueCount",
    "maxSeverity",
    "severity",
  ]);
  return Object.fromEntries(
    columns.map((c) => [
      c,
      tsColumns.has(c) ? "TIMESTAMP" : numeric.has(c) ? "BIGINT" : "VARCHAR",
    ]),
  );
}

/**
 * Parse one export data file (gzipped NDJSON) into classified rows.
 * Handles both export shapes: full (`{"Item": …}`) and incremental
 * NEW_IMAGE_ONLY (`{"Keys":…, "NewImage":…}` — items without NewImage are
 * deletes and are skipped; ADR 0013 §Consequences).
 * @param {NodeJS.ReadableStream} body
 * @param {string} exportedAt
 * @returns {Promise<Map<string, Record<string, unknown>[]>>} entity → rows
 */
export async function parseExportFile(body, exportedAt) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byEntity = new Map();
  const rl = readline.createInterface({
    input: body.pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // torn/trailing line — skip rather than fail the whole export
    }
    const image = record.Item ?? record.NewImage;
    if (!image) continue; // delete record (no NewImage) — skip
    const item = /** @type {Record<string, unknown>} */ (unmarshall(image));
    const entity = classifyItem(/** @type {any} */ (item));
    if (!entity) continue;
    const rows = byEntity.get(entity) ?? [];
    rows.push(toRow(entity, item, exportedAt));
    byEntity.set(entity, rows);
  }
  return byEntity;
}

/**
 * Convert one export: read its manifest, parse all data files, write one
 * Parquet file per (entity, date). Files are staged in tmp (DuckDB COPY writes
 * to local disk; httpfs-to-S3 needs credentials this runtime has but keeps the
 * write path simpler), then uploaded.
 * @param {string} bucket
 * @param {string} manifestSummaryKey full key of manifest-summary.json
 * @param {string} exportedAt ISO stamp (the export's own timestamp)
 * @returns {Promise<{ files: string[], rows: number }>}
 */
export async function convertExport(bucket, manifestSummaryKey, exportedAt) {
  const summary = await getJson(bucket, manifestSummaryKey);
  const manifestKey = summary.manifestFilesS3Key;
  if (!manifestKey)
    throw new Error("manifest-summary.json missing manifestFilesS3Key");
  const dataFiles = await listManifestDataFiles(bucket, manifestKey);
  if (dataFiles.length === 0)
    throw new Error("export manifest lists no data files");

  // Export ID for idempotent file naming: the export directory itself.
  const exportId = manifestSummaryKey.split("/")[2] ?? "unknown-export";
  const tmpDir = await mkdtemp(join(tmpdir(), "gnp-convert-"));
  /** @type {string[]} */
  const written = [];
  let totalRows = 0;

  try {
    /** @type {Map<string, Record<string, unknown>[]>} */
    const rowsByEntityDate = new Map(); // `${entity}|${date}` → rows
    for (const key of dataFiles) {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!res.Body) continue;
      // S3 GetObject streams are Node Readables at runtime; the SDK's union
      // type just can't see it. parseExportFile pipes through gunzip.
      const byEntity = await parseExportFile(
        /** @type {any} */ (res.Body),
        exportedAt,
      );
      for (const [entity, rows] of byEntity) {
        for (const row of rows) {
          const date = row.date ?? "unknown";
          const k = `${entity}|${date}`;
          const list = rowsByEntityDate.get(k) ?? [];
          list.push(row);
          rowsByEntityDate.set(k, list);
        }
      }
    }

    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();

    for (const [entityDate, rows] of rowsByEntityDate) {
      const [entity, date] = entityDate.split("|");
      const columns = ENTITY_COLUMNS[entity];
      if (!columns) continue;
      // Stage rows as NDJSON, pin the column types explicitly, and COPY out as
      // ZSTD Parquet. read_json samples rows to infer types; a promoted column
      // that is null in every sampled row infers JSON, which poisons the view
      // when a later export writes a plain VARCHAR into the same column — so
      // every entity pins its schema via columnSchema(). File name carries the
      // export ID so re-running the same export overwrites in place (ADR 0013
      // §Decision 2).
      const ndjsonPath = join(tmpDir, `${entity}-${date}.ndjson`);
      await writeFile(
        ndjsonPath,
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
      const parquetPath = join(tmpDir, `${entity}-${date}.parquet`);
      await conn.run(
        `COPY (
          SELECT ${columns
            .map((c) => (c === "raw" ? "CAST(raw AS VARCHAR) AS raw" : c))
            .join(", ")}
          FROM read_json('${ndjsonPath}', format = 'newline_delimited', columns = ${JSON.stringify(
            columnSchema(columns),
          )})
          ORDER BY ${columns[0]}
        ) TO '${parquetPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      const parquet = await readFile(parquetPath);
      const s3Key = `readings/${entity}/date=${date}/part-${exportId}.parquet`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: parquet,
          ServerSideEncryption: "aws:kms",
          ContentType: "application/vnd.apache.parquet",
        }),
      );
      written.push(s3Key);
      totalRows += rows.length;
      await rm(parquetPath, { force: true });
      await rm(ndjsonPath, { force: true });
    }
    await conn.closeSync();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  return { files: written, rows: totalRows };
}

/**
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<any>}
 */
async function getJson(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`empty S3 object ${key}`);
  const text = await res.Body.transformToString("utf8");
  return JSON.parse(text);
}

/**
 * Parse manifest-files.json, which DynamoDB emits as **JSON Lines** — one
 * `{ dataFileS3Key, itemCount, md5checksumValue }` descriptor per line — not
 * as a single JSON object. (manifest-summary.json IS a single JSON object;
 * this file is not.) Exported for unit tests.
 * @param {string} bucket
 * @param {string} key full S3 key of the manifest-files.json object
 * @returns {Promise<string[]>} data file keys
 */
export async function listManifestDataFiles(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`empty S3 object ${key}`);
  const text = await res.Body.transformToString("utf8");
  /** @type {string[]} */
  const files = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `manifest line is not valid JSON: ${trimmed.slice(0, 80)}`,
      );
    }
    if (typeof entry.dataFileS3Key === "string" && entry.dataFileS3Key) {
      files.push(entry.dataFileS3Key);
    }
  }
  return files;
}

/**
 * Lambda entrypoint body: parse the S3 event, convert each triggered export
 * manifest. Exported for unit tests; the lambda entrypoint wraps error logging.
 * @param {any} event S3 event (one or more manifest-summary.json records)
 * @returns {Promise<{ converted: number, files: number, rows: number }>}
 */
export async function convertS3Event(event) {
  const bucket = process.env.LAKE_BUCKET;
  if (!bucket) throw new Error("Missing LAKE_BUCKET");
  let converted = 0;
  let files = 0;
  let rows = 0;
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(
      record?.s3?.object?.key?.replace(/\+/g, " ") ?? "",
    );
    if (!key.endsWith("manifest-summary.json")) continue;
    // Exported-at stamp: the manifest summary's lastModified, not the
    // conversion time, so ordering is stable across converter retries.
    const exportedAt = new Date(record?.eventTime ?? Date.now()).toISOString();
    const result = await convertExport(bucket, key, exportedAt);
    converted += 1;
    files += result.files.length;
    rows += result.rows;
  }
  console.log(
    JSON.stringify({ marker: "AnalyticsConvertDone", converted, files, rows }),
  );
  return { converted, files, rows };
}
