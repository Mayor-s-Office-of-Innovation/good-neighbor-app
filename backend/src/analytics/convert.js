// DynamoDB export JSON → entity-split Parquet (ADR 0013 Phase 3).
//
// Trigger: manifest-summary.json landing under raw/ in the lake bucket. This
// module resolves the export's manifest, streams each gzipped NDJSON data file,
// unmarshals DynamoDB typed JSON, classifies each item by its complete key into an
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
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DuckDBInstance } from "@duckdb/node-api";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyItem } from "./entity-keys.js";
import { backfillIfFormatChanged } from "./backfill.js";
import { logServerError } from "../lib/log-server-error.js";

export { classifyItem } from "./entity-keys.js";

// MinIO in the local pipeline only speaks path-style; real S3 is unchanged.
const s3 = new S3Client(
  process.env.AWS_ENDPOINT_URL_S3 ? { forcePathStyle: true } : {},
);
// Only the backfill uses it, to start a full table export after a format change.
const dynamo = new DynamoDBClient({});

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

// Bump when toRow, ENTITY_COLUMNS or key shapes change, so raw exports re-convert.
export const FORMAT_VERSION = 4;

// Entities recognized by key shape; see classifyItem(). Anything unrecognized
// (receipts, counters, pointers, PROVIDER_SEARCH, setup-code items) is
// skipped — only reporting entities reach the lake.

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
    raw: JSON.stringify(
      entity === "task_updates"
        ? updateOnly(item)
        : entity === "programs"
          ? programOnly(item)
          : entity === "compliance_terms"
            ? termsOnly(item)
            : item,
    ),
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
      // The stored condition (guidance-store.js) keeps its event time under
      // source.reportedAt — there is no top-level reportedAt, only
      // createdAt/updatedAt. Reading the top level put every condition in
      // date=unknown; fall back to createdAt so none ever does.
      const source = /** @type {Record<string, unknown> | undefined} */ (
        typeof item.source === "object" && item.source !== null
          ? item.source
          : undefined
      );
      // source.reportedAt is client-supplied and unvalidated (guidance.js),
      // so prefer the first candidate that yields a real partition date
      // rather than the first string present.
      const candidates = [str(source?.reportedAt), str(item.createdAt)];
      const reportedAt =
        candidates.find((c) => dateFromTimestamp(c) !== null) ?? candidates[0];
      // outcome is the matched rule's outcome object; its `kind` is the
      // scalar worth a column. The full object stays in raw.
      const outcome = /** @type {Record<string, unknown> | undefined} */ (
        typeof item.outcome === "object" && item.outcome !== null
          ? item.outcome
          : undefined
      );
      Object.assign(row, {
        assessmentId: str(item.assessmentId),
        conditionId: str(item.conditionId),
        // Condition items carry the analyzer's raw label and the app's
        // canonical one (guidance-store.js) — 'category' does not exist.
        canonicalCategory: str(item.canonicalCategory),
        analyzerCategory: str(item.analyzerCategory),
        severity: num(item.severity),
        outcome: str(outcome?.kind),
        conditionStatus: str(item.status),
        reportedAt,
        date: dateFromTimestamp(reportedAt),
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
    case "task_updates": {
      Object.assign(row, {
        taskId: str(item.taskId),
        updateId: str(item.updateId),
        updateType: str(item.type),
        occurredAt: str(item.occurredAt),
        date: dateFromTimestamp(str(item.occurredAt)),
      });
      break;
    }
    case "duplicate_links":
    case "duplicate_overrides": {
      Object.assign(row, {
        taskId: str(item.taskId),
        originalTaskId: str(item.originalTaskId),
        occurredAt: str(item.occurredAt),
        date: dateFromTimestamp(str(item.occurredAt)),
      });
      break;
    }
    case "compliance_terms": {
      Object.assign(row, {
        termsVersionId: str(item.termsVersionId),
        effectiveStart: str(item.effectiveStart),
        date: dateFromTimestamp(str(item.createdAt)),
      });
      break;
    }
    case "programs": {
      Object.assign(row, {
        programId: str(item.programId),
        name: str(item.name),
        updatedAt: str(item.updatedAt),
        date: dateFromTimestamp(str(item.updatedAt)),
      });
      break;
    }
  }
  return row;
}

// Local lake folders may hold an apostrophe.
/**
 * @param {string} value
 * @returns {string}
 */
export function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

// Staff text, photos and who acted stay out; the lake keeps rows forever.
const TASK_UPDATE_FIELDS = [
  "pk",
  "sk",
  "siteId",
  "entityType",
  "taskId",
  "updateId",
  "type",
  "label",
  "occurredAt",
  "documentationState",
  "presencePeriod",
];

/**
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function updateOnly(item) {
  return Object.fromEntries(
    Object.entries(item).filter(([k]) => TASK_UPDATE_FIELDS.includes(k)),
  );
}

// The program contact's name, email and phone stay out; the lake keeps rows forever.
const PROGRAM_FIELDS = ["pk", "sk", "programId", "name", "updatedAt"];

/**
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function programOnly(item) {
  return Object.fromEntries(
    Object.entries(item).filter(([k]) => PROGRAM_FIELDS.includes(k)),
  );
}

// The letter's email and names stay out; the lake keeps rows forever.
const TERMS_FIELDS = [
  "pk",
  "sk",
  "siteId",
  "termsVersionId",
  "effectiveStart",
  "periodEnd",
  "expiresOnExclusive",
  "requiredChecksPerDay",
  "underEnhancedMonitoring",
  "reasons",
  "status",
  "endedAt",
  "endedOn",
  "createdAt",
];

/**
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function termsOnly(item) {
  return Object.fromEntries(
    Object.entries(item).filter(([k]) => TERMS_FIELDS.includes(k)),
  );
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Shape alone lets "2026-99-99" or "2026-02-30" through as a partition;
  // require a real calendar date (round-trip, since V8 rolls Feb 30 over).
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === date ? date : null;
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
  task_updates: [
    "siteId",
    "taskId",
    "updateId",
    "updateType",
    "occurredAt",
    "exportedAt",
    "raw",
  ],
  duplicate_links: [
    "siteId",
    "taskId",
    "originalTaskId",
    "occurredAt",
    "exportedAt",
    "raw",
  ],
  duplicate_overrides: [
    "siteId",
    "taskId",
    "originalTaskId",
    "occurredAt",
    "exportedAt",
    "raw",
  ],
  programs: ["siteId", "programId", "name", "updatedAt", "exportedAt", "raw"],
  compliance_terms: [
    "siteId",
    "termsVersionId",
    "effectiveStart",
    "exportedAt",
    "raw",
  ],
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

// Exported so the local Insights lake matches what exports write.
/**
 * @param {any} conn
 * @param {string} entity
 * @param {Record<string, unknown>[]} rows
 * @param {string} parquetPath
 * @returns {Promise<void>}
 */
export async function writeEntityParquet(conn, entity, rows, parquetPath) {
  const columns = ENTITY_COLUMNS[entity];
  if (!columns) throw new Error(`unknown lake entity: ${entity}`);
  // read_json infers JSON for a column null in every sampled row, which breaks the view
  // once a later export writes VARCHAR there, so every entity pins its schema.
  const ndjsonPath = `${parquetPath}.ndjson`;
  await writeFile(ndjsonPath, rows.map((r) => JSON.stringify(r)).join("\n"));
  try {
    await conn.run(
      `COPY (
        SELECT ${columns
          .map((c) => (c === "raw" ? "CAST(raw AS VARCHAR) AS raw" : c))
          .join(", ")}
        FROM read_json(${sqlString(ndjsonPath)}, format = 'newline_delimited', columns = ${JSON.stringify(
          columnSchema(columns),
        )})
        ORDER BY ${columns[0]}
      ) TO ${sqlString(parquetPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
  } finally {
    await rm(ndjsonPath, { force: true });
  }
}

/**
 * Convert one export: read its manifest, parse all data files, write one
 * Parquet file per (entity, date). Files are staged in tmp (DuckDB COPY writes
 * to local disk; httpfs-to-S3 needs credentials this runtime has but keeps the
 * write path simpler), then uploaded.
 * @param {string} bucket
 * @param {string} manifestSummaryKey full key of manifest-summary.json
 * @param {string} fallbackAt ISO stamp for a summary without an export time
 * @returns {Promise<{ files: string[], rows: number }>}
 */
export async function convertExport(bucket, manifestSummaryKey, fallbackAt) {
  const summary = await getJson(bucket, manifestSummaryKey);
  const exportedAt = exportStamp(summary, fallbackAt);
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
  /** @type {import("@duckdb/node-api").DuckDBInstance | undefined} */
  let db;
  /** @type {import("@duckdb/node-api").DuckDBConnection | undefined} */
  let conn;

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

    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();

    for (const [entityDate, rows] of rowsByEntityDate) {
      const [entity, date] = entityDate.split("|");
      const columns = ENTITY_COLUMNS[entity];
      if (!columns) continue;
      // The export ID in the name makes a rerun overwrite in place (ADR 0013 §Decision 2).
      const parquetPath = join(tmpDir, `${entity}-${date}.parquet`);
      await writeEntityParquet(conn, entity, rows, parquetPath);
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
    }
  } finally {
    // A backfill converts many exports in one invocation, so free each instance.
    conn?.closeSync();
    db?.closeSync();
    await rm(tmpDir, { recursive: true, force: true });
  }

  return { files: written, rows: totalRows };
}

// The trigger and the backfill both stamp from the summary, so a re-converted
// row orders against newer rows the same way its first conversion did.
/**
 * @param {Record<string, unknown>} summary manifest-summary.json
 * @param {string} fallback
 * @returns {string}
 */
export function exportStamp(summary, fallback) {
  const at = Date.parse(String(summary.exportToTime ?? summary.exportTime));
  return Number.isNaN(at) ? fallback : new Date(at).toISOString();
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
 * @param {{ getRemainingTimeInMillis?: () => number }} [context] Lambda context
 * @returns {Promise<{ converted: number, files: number, rows: number, backfilled: number }>}
 */
export async function convertS3Event(event, context) {
  const bucket = process.env.LAKE_BUCKET;
  if (!bucket) throw new Error("Missing LAKE_BUCKET");
  let converted = 0;
  let files = 0;
  let rows = 0;
  const seen = new Set();
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(
      record?.s3?.object?.key?.replace(/\+/g, " ") ?? "",
    );
    if (!key.endsWith("manifest-summary.json")) continue;
    // Only for a summary without an export time; the conversion time would reorder retries.
    const fallbackAt = new Date(record?.eventTime ?? Date.now()).toISOString();
    const result = await convertExport(bucket, key, fallbackAt);
    seen.add(key);
    converted += 1;
    files += result.files.length;
    rows += result.rows;
  }
  let backfilled = 0;
  // Off where the converter role can't list raw/, read its state or start an export, or every export logs AccessDenied.
  if (converted && process.env.ANALYTICS_BACKFILL_ENABLED === "true")
    try {
      ({ backfilled } = await backfillIfFormatChanged({
        send: (command) => s3.send(command),
        ddbSend: (command) => dynamo.send(command),
        tableArn: process.env.DYNAMO_TABLE_ARN,
        convert: convertExport,
        bucket,
        prefix: process.env.EXPORT_PREFIX || "raw",
        formatVersion: FORMAT_VERSION,
        skip: seen,
        timeLeftMs: context?.getRemainingTimeInMillis
          ? () => /** @type {any} */ (context).getRemainingTimeInMillis()
          : undefined,
      }));
    } catch (err) {
      // This export is already converted; the next one retries the backfill.
      logServerError("analytics-convert backfill", err);
    }
  console.log(
    JSON.stringify({
      marker: "AnalyticsConvertDone",
      converted,
      files,
      rows,
      backfilled,
    }),
  );
  return { converted, files, rows, backfilled };
}
