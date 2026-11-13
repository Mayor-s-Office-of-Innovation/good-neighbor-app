// Times the shipped Insights reader (snapshot.js and read-model.js), which
// queries the projection's Parquet files with one long-lived DuckDB instance.
// The analytics Lambda has 2 GB.
//
//   npm run insights:bench -w backend -- [--sites 500,1000] [--years 1,2] [--runs 30]
//
// Queries: Overview and Trends for the 12 months before this month (Trends by
// department), Site detail for the same 12 months, last month's first page of
// Issues, and the two jobs that build the most rows: a CSV of the 12 months'
// Issues, and a report on every Site for the 12 months.
//
// Input is the projection from `npm run insights:data`. Sizes copy each Site's
// rows under new Site IDs, and each extra year moves every row back by the
// data's span, sorted and grouped as the build writes them, so copies change
// the size, not the rules. Built files are kept in backend/.local/insights-bench/
// and reused while the input is unchanged.
//
// Each query × size runs in its own Node process with
// --max-old-space-size=2048, the Lambda's memory, so one query's garbage
// can't slow another. A run whose peak RSS, native memory included, passes
// 2,048 MiB fails, as it would on the Lambda. docs/dev-commands.md lists the
// options and columns.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sqlString } from "../src/analytics/convert.js";
import { addMonthsToFirst, pacificDateKey } from "../src/lib/pacific-dates.js";
import { toCsv } from "../src/reporting/api/csv.js";
import {
  exportRows,
  listIssues,
  overview,
  reportDataset,
  siteDetail,
  trends,
} from "../src/reporting/api/read-model.js";
import {
  createSnapshotStore,
  dirSource,
} from "../src/reporting/api/snapshot.js";
import { TABLE_SCHEMAS } from "../src/reporting/projection.js";
import { ROW_GROUP_SIZE } from "../src/reporting/projection-sql.js";
import {
  parseListQuery,
  parsePeriodParams,
} from "../src/reporting/api/requests.js";

const HEAP_MB = 2048;
export const QUERIES = [
  "overview",
  "trends",
  "site",
  "issues",
  "export",
  "report",
];
const QUERY_LABELS = {
  overview: "Overview, 12 months",
  trends: "Trends, 12 months",
  site: "Site detail, 12 months",
  issues: "Issues, a month",
  export: "Issues CSV, 12 months",
  report: "Report, every Site, 12 months",
};
// Each job run takes seconds at 1,000 Sites, and a few runs give its spread.
const JOB_RUNS = 5;
const BENCH_DIR = fileURLToPath(
  new URL("../.local/insights-bench", import.meta.url),
);
const DATA_DIR = fileURLToPath(
  new URL("../.local/insights-data", import.meta.url),
);

/**
 * @param {string} list
 * @param {string} name
 * @returns {number[]}
 */
export function wholeNumbers(list, name) {
  const xs = list.split(",").map(Number);
  if (xs.some((n) => !Number.isInteger(n) || n < 1))
    throw new Error(`${name} must be whole numbers of 1 or more`);
  return xs;
}

/**
 * The requests every query answers, from the snapshot's own clock.
 * @param {Record<string, any>} manifest
 */
export function requests(manifest) {
  const { evaluatedAt } = manifest;
  // Pacific days, as the API reads them; UTC slicing is a day off at night.
  const today = pacificDateKey(evaluatedAt);
  const year = parsePeriodParams(
    {
      period: "custom",
      from: addMonthsToFirst(today, -12),
      to: addMonthsToFirst(today, 0),
    },
    evaluatedAt,
  );
  const month = parsePeriodParams(
    { period: "month", month: addMonthsToFirst(today, -1).slice(0, 7) },
    evaluatedAt,
  );
  return {
    evaluatedAt,
    today,
    now: Date.parse(evaluatedAt),
    year,
    month,
    siteList: parseListQuery("sites", {}),
    issueList: parseListQuery("issues", {}),
  };
}

/**
 * Each query as the API runs it, on a snapshot the shipped store opened.
 * The jobs include writing the file, since that's where their rows are held.
 * @param {import("../src/reporting/api/snapshot.js").Snapshot} snap
 * @param {ReturnType<typeof requests>} req
 * @returns {Record<string, () => Promise<unknown>>}
 */
export function queriesFor(snap, req) {
  const { now, year, month } = req;
  return {
    overview: () =>
      overview(snap, {
        interval: year,
        filter: {},
        list: req.siteList,
        now,
      }),
    trends: () =>
      trends(snap, {
        interval: year,
        scope: {},
        breakdown: "department",
        now,
      }),
    site: () =>
      siteDetail(snap, snap.sites[0]?.siteId ?? "", { interval: year, now }),
    issues: () =>
      listIssues(snap, {
        interval: month,
        filter: {},
        list: req.issueList,
        now,
      }),
    export: async () => {
      const { columns, rows } = await exportRows(snap, {
        dataset: "issues",
        interval: year,
        filter: {},
        list: parseListQuery("issues", {}),
      });
      return toCsv(columns, rows).length;
    },
    report: async () =>
      JSON.stringify(
        await reportDataset(snap, {
          siteIds: snap.sites.map((s) => s.siteId).sort(),
          interval: year,
          now,
        }),
      ).length,
  };
}

/**
 * @param {number[]} sorted
 * @param {number} q
 */
export const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * One query × size, timed in this process.
 * @param {string} query
 * @param {string} dir
 * @param {{ runs: number }} opts
 */
export async function measure(query, dir, { runs }) {
  let peakHeap = 0;
  const sample = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };
  const store = createSnapshotStore({ source: dirSource(dir) });
  /** @type {number[]} */
  const times = [];
  let coldMs = 0;
  // Closed so each run's snapshot copy in the temp folder goes with it.
  try {
    const snap = await store.current();
    const run = queriesFor(snap, requests(snap.manifest))[query];
    if (!run) throw new Error(`no query named ${query}`);
    await run();
    // performance.now() counts from process start, so this includes imports.
    coldMs = performance.now();
    sample();
    const warmRuns = ["export", "report"].includes(query)
      ? Math.min(runs, JOB_RUNS)
      : runs;
    for (let i = 0; i < warmRuns; i += 1) {
      const started = performance.now();
      await run();
      times.push(performance.now() - started);
      sample();
    }
  } finally {
    await store.close();
  }
  times.sort((a, b) => a - b);
  return {
    coldMs,
    // libuv reports maxRSS in kilobytes on every platform.
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    peakHeapMiB: peakHeap / 1048576,
    warmP50: quantile(times, 0.5),
    warmP95: quantile(times, 0.95),
  };
}

// insights:data keeps the generator's fixed snapshot ID, so a rerun is spotted by the whole manifest.
/**
 * @param {string} text the input's manifest.json
 * @returns {string}
 */
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

/**
 * @param {Record<string, any> | null} built a sized copy's manifest
 * @param {string} baseText the input's manifest.json
 * @returns {boolean}
 */
export function builtFrom(built, baseText) {
  return built?.bench?.base === hashOf(baseText);
}

/**
 * The input projection copied up to `sites` Sites and `years` years.
 * @param {string} base
 * @param {string} out
 * @param {number} sites
 * @param {number} years
 */
export async function buildSize(base, out, sites, years) {
  const tmp = `${out}.partial`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const baseText = await readFile(join(base, "manifest.json"), "utf8");
  const manifest = JSON.parse(baseText);
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  /** @param {string} name */
  const src = (name) =>
    `read_parquet(${sqlString(join(base, `${name}.parquet`))})`;
  /** @param {string} sql */
  const all = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS();
  try {
    const [{ n, span }] = await all(
      `SELECT (SELECT count(*) FROM ${src("sites")}) AS n,
         CAST(max(day) - min(day) + 1 AS INTEGER) AS span FROM ${src("site_days")}`,
    );
    const copies = Math.ceil(sites / Number(n));
    await conn.run(
      `CREATE TEMP TABLE pick AS SELECT siteId AS baseId, c, idx FROM
         (SELECT siteId, row_number() OVER (ORDER BY siteId) - 1 AS idx FROM ${src("sites")}),
         range(${copies}) AS r(c)
       WHERE c * ${Number(n)} + idx < ${sites}`,
    );
    // A whole span back, not 365 days, so moved rows never share a day.
    const shiftDay = (/** @type {string} */ c) =>
      `${c} - CAST(y * ${span} AS INTEGER)`;
    const shiftTime = (/** @type {string} */ c) =>
      `CASE WHEN y = 0 OR ${c} IS NULL THEN ${c} ELSE strftime(CAST(${c} AS TIMESTAMP) - to_days(CAST(y * ${span} AS INTEGER)), '%Y-%m-%dT%H:%M:%S.%gZ') END`;
    const suffix = `CASE WHEN c = 0 THEN '' ELSE '-copy' || c END`;
    const ySuffix = `CASE WHEN y = 0 THEN '' ELSE '-y' || y END`;
    // Day first, so a period's query skips other days' row groups; any new
    // dated table gets the same order without a change here.
    /** @type {Record<string, string>} */
    const order = {
      issues: "createdDay, siteId, issueId",
      checks: "day, siteId, checkId",
    };
    for (const [name, schema] of Object.entries(TABLE_SCHEMAS)) {
      const dated = !["sites", "site_contacts"].includes(name);
      const columns = Object.entries(schema).map(([col, type]) => {
        if (col === "siteId") return `t.siteId || ${suffix} AS siteId`;
        if (col === "issueId" || col === "checkId")
          return `CASE WHEN t.${col} IS NULL THEN NULL ELSE t.${col} || ${suffix} || ${dated ? ySuffix : "''"} END AS ${col}`;
        if (col === "name" && name === "sites")
          return `CASE WHEN c = 0 THEN t.name ELSE t.name || ' (copy ' || c || ')' END AS name`;
        if (!dated) return `t.${col}`;
        if (type === "DATE") return `${shiftDay(`t.${col}`)} AS ${col}`;
        if (col.endsWith("At")) return `${shiftTime(`t.${col}`)} AS ${col}`;
        return `t.${col}`;
      });
      await conn.run(
        `COPY (SELECT ${columns.join(", ")}
           FROM ${src(name)} AS t JOIN pick ON pick.baseId = t.siteId
           ${dated ? `, range(${years}) AS yr(y)` : ""}
           ORDER BY ${order[name] ?? ("day" in schema ? "day, siteId" : "siteId")})
         TO ${sqlString(join(tmp, `${name}.parquet`))}
         (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`,
      );
    }
    /** @type {Record<string, number>} */
    const rowCounts = {};
    for (const name of Object.keys(TABLE_SCHEMAS)) {
      const [{ rows }] = await all(
        `SELECT count(*) AS rows FROM read_parquet(${sqlString(join(tmp, `${name}.parquet`))})`,
      );
      rowCounts[name] = Number(rows);
    }
    await writeFile(
      join(tmp, "manifest.json"),
      JSON.stringify(
        {
          ...manifest,
          rowCounts,
          bench: { sites, years, copies, span, base: hashOf(baseText) },
        },
        null,
        2,
      ),
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  await rm(out, { recursive: true, force: true });
  await rename(tmp, out);
}

/**

/**
 * @param {string} dir
 * @param {string} query
 */
export async function fileBytes(dir, query) {
  const tables = {
    overview: ["site_days", "issues", "sites"],
    trends: ["site_days", "issues", "sites"],
    site: ["site_days", "sites"],
    issues: ["issues", "sites"],
    export: ["issues", "sites"],
    report: ["site_days", "issues", "checks_owed", "sites", "site_contacts"],
  };
  let n = 0;
  for (const name of /** @type {Record<string, string[]>} */ (tables)[query])
    n += (await stat(join(dir, `${name}.parquet`))).size;
  return n;
}

/**
 * A finished child process, read as a result or a failure.
 * @param {{ code: number | null, signal: string | null, out: string, err: string }} run
 * @returns {Record<string, any>}
 */
export function childResult({ code, signal, out, err }) {
  const line = out.trim().split("\n").at(-1);
  /** @type {any} */
  let result = null;
  try {
    if (code === 0 && line) result = JSON.parse(line);
  } catch {
    // A stray stdout line; reported below as a failure.
  }
  if (result && result.peakRssMiB > HEAP_MB)
    return {
      ok: false,
      failure: `peak RSS ${Math.round(result.peakRssMiB)} MiB, over the Lambda's ${HEAP_MB}`,
      detail: "",
    };
  if (result) return { ok: true, ...result };
  const oom = /heap out of memory|Allocation failed/i.test(err);
  // The message comes before the stack; the last lines are frames.
  const lines = err.trim().split("\n");
  const message = lines.filter((l) => /error/i.test(l)).slice(0, 2);
  return {
    ok: false,
    failure: oom
      ? `out of memory at ${HEAP_MB} MiB heap`
      : `exit ${code ?? signal}`,
    detail: (message.length ? message : lines.slice(0, 3)).join(" "),
  };
}

/**
 * @param {string} query
 * @param {string} dir
 * @param {{ runs: number }} opts
 * @returns {Promise<Record<string, any>>}
 */
function runChild(query, dir, { runs }) {
  return new Promise((done) => {
    const proc = spawn(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MB}`,
        fileURLToPath(import.meta.url),
        "--child",
        query,
        "--data",
        dir,
        "--runs",
        String(runs),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (b) => (out += b));
    proc.stderr.on("data", (b) => (err += b));
    proc.on("error", (e) =>
      done({ ok: false, failure: "could not start", detail: e.message }),
    );
    proc.on("close", (code, signal) =>
      done(childResult({ code, signal, out, err })),
    );
  });
}

/**
 * @param {{ dir?: string, sites: string, years: string, runs: string, rebuild?: boolean, json?: string }} opts
 * @param {string} [benchDir] where sized copies are built
 * @returns {Promise<Record<string, any>[]>} one result per size and query
 */
export async function main(opts, benchDir = BENCH_DIR) {
  const sizes = wholeNumbers(opts.sites, "--sites");
  const yearsList = wholeNumbers(opts.years, "--years");
  const [runs] = wholeNumbers(opts.runs, "--runs");
  const dataDir = opts.dir ?? DATA_DIR;
  const base = join(dataDir, "projection");
  if (!existsSync(join(base, "manifest.json")))
    throw new Error(
      `no projection in ${dataDir}; run npm run insights:data -w backend first`,
    );
  const baseText = await readFile(join(base, "manifest.json"), "utf8");
  /** @type {Record<string, any>[]} */
  const results = [];
  for (const sites of sizes)
    for (const years of yearsList) {
      const label = `${sites} Sites, ${years} year${years > 1 ? "s" : ""}`;
      const dir = join(benchDir, `${sites}-sites-${years}y`);
      const stamp = existsSync(join(dir, "manifest.json"))
        ? JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))
        : null;
      if (opts.rebuild || !builtFrom(stamp, baseText)) {
        const started = performance.now();
        await buildSize(base, dir, sites, years);
        console.log(
          `[insights-bench] built ${label} in ${((performance.now() - started) / 1000).toFixed(1)} s`,
        );
      }
      const { rowCounts } = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8"),
      );
      console.log(
        `[insights-bench] ${label}: ${Object.entries(rowCounts)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`,
      );
      for (const query of QUERIES) {
        const r = await runChild(query, dir, { runs });
        r.fileMB = (await fileBytes(dir, query)) / 1e6;
        results.push({ size: label, sites, years, query, ...r });
      }
      const rows = results.filter((r) => r.size === label);
      console.log(`\n${label}`);
      console.table(
        Object.fromEntries(
          rows.map((r) => [
            QUERY_LABELS[/** @type {keyof typeof QUERY_LABELS} */ (r.query)],
            r.ok
              ? {
                  "cold ms": Math.round(r.coldMs),
                  "peak RSS MiB": Math.round(r.peakRssMiB),
                  "peak heap MiB": Math.round(r.peakHeapMiB),
                  "warm p50 ms": r.warmP50.toFixed(1),
                  "warm p95 ms": r.warmP95.toFixed(1),
                  "files MB": r.fileMB.toFixed(2),
                }
              : { "cold ms": r.failure, "files MB": r.fileMB.toFixed(2) },
          ]),
        ),
      );
    }
  if (opts.json) await writeFile(opts.json, JSON.stringify(results, null, 2));
  for (const r of results)
    if (!r.ok)
      console.error(
        `[insights-bench] ${r.size}, ${r.query}: ${r.failure}. ${r.detail}`,
      );
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: args } = parseArgs({
    options: {
      dir: { type: "string" },
      sites: { type: "string", default: "500,1000" },
      years: { type: "string", default: "1,2" },
      runs: { type: "string", default: "30" },
      rebuild: { type: "boolean", default: false },
      json: { type: "string" },
      child: { type: "string" },
      data: { type: "string" },
    },
  });
  if (args.child) {
    if (!args.data) throw new Error("--child needs --data");
    const result = await measure(args.child, args.data, {
      runs: Number(args.runs),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    try {
      const results = await main(args);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    } catch (e) {
      console.error(`[insights-bench] ${/** @type {Error} */ (e).message}`);
      process.exitCode = 1;
    }
  }
}
