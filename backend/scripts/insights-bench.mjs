// Times design B, the Insights read the plan picked: one long-lived DuckDB
// instance queries the Parquet files per request. The analytics Lambda has 2 GB.
//
//   npm run insights:bench -w backend -- [--sites 500,1000] [--years 1,2] [--runs 30]
//
// Files are sorted by day and cut into 16,384-row groups, so a period's query
// skips the other days' row groups and unused columns. Queries: Overview and
// Trends for the 12 months before this month (Trends by department), Site
// detail for the same 12 months, and last month's first page of Issues.
// The in-memory and browser designs it was picked over were measured on
// 11/05; their numbers are in the architecture doc.
//
// Input is the projection from `npm run insights:data` (24 Sites, a year).
// Sizes are made from it by copying each Site's rows under new Site IDs,
// and each extra year by copying every row with its days moved back by the
// data's span. Copies change the size, not the rules. Built files are kept in
// backend/.local/insights-bench/ and reused while the input is unchanged.
//
// Each query × size runs in its own Node process with
// --max-old-space-size=2048, the Lambda's memory, so one query's garbage
// can't slow another. A run whose peak RSS, native memory included, passes
// 2,048 MiB fails, as it would on the Lambda.
//
// Options:
//   --dir      insights:data output folder (default backend/.local/insights-data)
//   --sites    Site counts, comma-separated (default 500,1000)
//   --years    years of data, comma-separated (default 1,2)
//   --runs     warm runs per query after the first answer (default 30)
//   --threads  DuckDB threads (default 1; a 2 GB Lambda has about 1.2 vCPUs)
//   --rebuild  rebuild the sized files even if the input is unchanged
//   --json     also write every result to this file
//
// Columns:
//   cold ms     process start to the first answer: imports, opening the
//               files, and the query
//   peak RSS    the process's peak resident memory, native memory included
//               (DuckDB's buffers count here, not in heap)
//   peak heap   the largest V8 heap in use, sampled after each answer
//   warm p50    median time per answer over --runs answers, same process
//   warm p95    95th percentile of those
//   files MB    bytes on disk of the files the query reads

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sqlString } from "../src/analytics/convert.js";
import {
  addDays,
  addMonthsToFirst,
  pacificDateKey,
} from "../src/lib/pacific-dates.js";
import { SITE_DAY_METRICS } from "../src/reporting/activity.js";
import { comparisonFor, previousOf } from "../src/reporting/periods.js";
import { TABLE_SCHEMAS } from "../src/reporting/projection.js";
import {
  parseListQuery,
  parsePeriodParams,
} from "../src/reporting/api/requests.js";

const HEAP_MB = 2048;
export const QUERIES = ["overview", "trends", "site", "issues"];
const QUERY_LABELS = {
  overview: "Overview, 12 months",
  trends: "Trends, 12 months",
  site: "Site detail, 12 months",
  issues: "Issues, a month",
};
// Small enough that a year of 500 Sites spans about ten groups to skip.
const ROW_GROUP = 16_384;
const NAMES = new Intl.Collator("en", { sensitivity: "base", numeric: true });
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

/** @param {Record<string, any> | undefined} row */
export const metricsOf = (row) =>
  Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, Number(row?.[m] ?? 0)]));

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
    siteId: "syn-site-01",
    siteList: parseListQuery("sites", {}),
    issueList: parseListQuery("issues", {}),
  };
}

/**
 * Trends' bucket edges, as read-model.js cuts them.
 * @param {{ startDay: string, endDay: string }} interval
 * @param {"week" | "month"} granularity
 * @param {string} today
 * @returns {{ start: string, end: string }[]}
 */
export function bucketRanges(interval, granularity, today) {
  const out = [];
  let start = interval.startDay;
  while (start < interval.endDay && start <= today) {
    const next =
      granularity === "week" ? addDays(start, 7) : addMonthsToFirst(start, 1);
    const end = next < interval.endDay ? next : interval.endDay;
    out.push({ start, end });
    start = end;
  }
  return out;
}

/**
 * Overview's default order: name, then ID, as read-model.js sorts it.
 * @param {{ siteId: string, name?: string | null }} a
 * @param {{ siteId: string, name?: string | null }} b
 */
export function byName(a, b) {
  for (const [x, y] of [
    [a.name ?? a.siteId, b.name ?? b.siteId],
    [a.name ?? "", b.name ?? ""],
  ]) {
    const c = NAMES.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
    if (c) return c;
  }
  return a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0;
}

/**
 * @param {string} dir
 * @param {ReturnType<typeof requests>} req
 * @param {number} [threads]
 */
export async function designB(dir, req, threads = 1) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:", {
    threads: String(threads),
    // DuckDB's memory sits outside the V8 heap cap.
    memory_limit: `${HEAP_MB}MiB`,
  });
  const conn = await instance.connect();
  // Keeps each file's footer between requests, as a warm Lambda would.
  await conn.run("SET parquet_metadata_cache = true");
  /** @param {string} name */
  const file = (name) =>
    `read_parquet(${sqlString(join(dir, `${name}.parquet`))})`;
  /** @param {string} sql */
  const all = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS();
  /** @param {string} day */
  const d = (day) => `DATE ${sqlString(day)}`;
  /**
   * @param {{ startDay: string, endDay: string }} r
   * @param {string} [col]
   */
  const within = (r, col = "day") =>
    `${col} >= ${d(r.startDay)} AND ${col} < ${d(r.endDay)}`;
  /**
   * @param {string} [where]
   * @param {string} [prefix]
   */
  const sums = (where, prefix = "") =>
    SITE_DAY_METRICS.map(
      (m) =>
        `CAST(coalesce(sum(${m})${where ? ` FILTER (WHERE ${where})` : ""}, 0) AS INTEGER) AS ${prefix}${m}`,
    ).join(", ");
  /**
   * @param {Record<string, any>} row
   * @param {string} prefix
   */
  const unprefix = (row, prefix) =>
    Object.fromEntries(
      SITE_DAY_METRICS.map((m) => [m, Number(row[prefix + m])]),
    );
  // Every Check and Issue adds a site_days row on its day, so the table's
  // first day is the coverage start; a snapshot never changes, so ask once.
  const [{ first }] = await all(
    `SELECT CAST(min(day) AS VARCHAR) AS first FROM ${file("site_days")}`,
  );
  const coverageStart = first ?? null;

  /**
   * A change block in read-model.js's shape: current, prior, change.
   * @param {{ startDay: string, endDay: string }} interval
   * @param {string} [siteWhere]
   */
  async function comparison(interval, siteWhere) {
    const cmp = comparisonFor(/** @type {any} */ (interval), req.evaluatedAt);
    if (!cmp.prior) return { cmp, change: null };
    const [row] = await all(
      `SELECT ${sums(within(cmp.current), "c_")}, ${sums(within(cmp.prior), "p_")}
       FROM ${file("site_days")}
       WHERE day >= ${d(cmp.prior.startDay)} AND day < ${d(cmp.current.endDay)}
       ${siteWhere ? `AND ${siteWhere}` : ""}`,
    );
    const cur = unprefix(row, "c_");
    const pri = unprefix(row, "p_");
    return {
      cmp,
      change: Object.fromEntries(
        SITE_DAY_METRICS.map((m) => [
          m,
          { current: cur[m], prior: pri[m], change: cur[m] - pri[m] },
        ]),
      ),
    };
  }

  /** @param {Record<string, number>} t */
  const split = (t) => ({ activity: t, response: {} });

  async function overview() {
    const interval = req.year;
    const bySite = await all(
      `SELECT siteId, ${sums()} FROM ${file("site_days")} WHERE ${within(interval)} GROUP BY siteId`,
    );
    const sev = await all(
      `SELECT siteId, max(severity) AS maxSeverity FROM ${file("issues")}
       WHERE ${within(interval, "createdDay")} GROUP BY siteId`,
    );
    const sites = await all(`SELECT siteId, name FROM ${file("sites")}`);
    const { change } = await comparison(interval);
    const totals = new Map(bySite.map((r) => [r.siteId, metricsOf(r)]));
    const maxSeverity = new Map(sev.map((r) => [r.siteId, r.maxSeverity]));
    const total = metricsOf({});
    for (const t of totals.values())
      for (const m of SITE_DAY_METRICS) total[m] += t[m];
    const rows = sites
      .map((s) => ({
        siteId: String(s.siteId),
        name: /** @type {string | null} */ (s.name),
        ...split(totals.get(s.siteId) ?? metricsOf({})),
        maxSeverity: maxSeverity.get(s.siteId) ?? null,
      }))
      .sort(byName);
    return {
      totals: split(total),
      comparison: { change },
      siteCount: sites.length,
      sites: rows.slice(0, req.siteList.limit),
    };
  }

  /**
   * @param {{ start: string, end: string }[]} ranges
   */
  const flagged = (ranges) =>
    ranges.map((b) => ({
      ...b,
      partial: b.end > req.today,
      noData: coverageStart === null || b.end <= coverageStart,
    }));

  async function trends() {
    const interval = req.year;
    const granularity =
      interval.kind === "year" || interval.kind === "financialYear"
        ? "month"
        : "week";
    const prior = previousOf(interval, req.evaluatedAt);
    const edges = {
      current: flagged(bucketRanges(interval, granularity, req.today)),
      prior: flagged(bucketRanges(prior, granularity, req.today)),
    };
    const values = Object.entries(edges)
      .flatMap(([k, list]) =>
        list.map(
          (b, i) => `(${sqlString(`${k}:${i}`)}, ${d(b.start)}, ${d(b.end)})`,
        ),
      )
      .join(", ");
    const sumsByBucket = new Map(
      (
        await all(
          `SELECT b.k, ${sums()} FROM ${file("site_days")}
           JOIN (VALUES ${values}) AS b(k, s, e) ON day >= b.s AND day < b.e
           GROUP BY b.k`,
        )
      ).map((r) => [r.k, metricsOf(r)]),
    );
    const series = Object.fromEntries(
      Object.entries(edges).map(([k, list]) => [
        k,
        list.map((b, i) => ({
          ...b,
          ...(sumsByBucket.get(`${k}:${i}`) ?? metricsOf({})),
        })),
      ]),
    );
    const { cmp, change } = await comparison(interval);
    const groups = await all(
      `SELECT coalesce(department, 'unknown') AS value, count(*) AS sites
       FROM ${file("sites")} GROUP BY 1`,
    );
    const lo = cmp.prior?.startDay ?? cmp.current.startDay;
    const groupSums = new Map(
      (
        await all(
          `SELECT coalesce(s.department, 'unknown') AS value, ${sums(within(cmp.current), "c_")}
           ${cmp.prior ? `, ${sums(within(cmp.prior), "p_")}` : ""}
           FROM ${file("site_days")} AS t JOIN ${file("sites")} AS s USING (siteId)
           WHERE day >= ${d(lo)} AND day < ${d(cmp.current.endDay)}
           GROUP BY 1`,
        )
      ).map((r) => [r.value, r]),
    );
    const categories = await all(
      `SELECT coalesce(category, 'unknown') AS category, CAST(count(*) AS INTEGER) AS issues,
         CAST(count(*) FILTER (WHERE severityBand = 'severe') AS INTEGER) AS severeIssues
       FROM ${file("issues")} WHERE ${within(interval, "createdDay")} GROUP BY 1`,
    );
    const siteCount = groups.reduce((n, g) => n + Number(g.sites), 0);
    return {
      scope: { siteCount },
      comparison: { change },
      series,
      categories: categories
        .sort(
          (a, b) => b.issues - a.issues || a.category.localeCompare(b.category),
        )
        .map((c) => ({
          category: c.category,
          issues: c.issues,
          severeIssues: c.severeIssues,
        })),
      breakdown: groups
        .sort((a, b) => a.value.localeCompare(b.value))
        .map((g) => {
          const s = groupSums.get(g.value);
          return {
            value: g.value,
            sites: Number(g.sites),
            current: s ? unprefix(s, "c_") : metricsOf({}),
            prior: cmp.prior ? (s ? unprefix(s, "p_") : metricsOf({})) : null,
          };
        }),
    };
  }

  async function site() {
    const interval = req.year;
    const where = `siteId = ${sqlString(req.siteId)}`;
    const [found] = await all(
      `SELECT siteId FROM ${file("sites")} WHERE ${where}`,
    );
    if (!found) throw new Error(`no Site ${req.siteId}`);
    const tomorrow = addDays(req.today, 1);
    const start =
      coverageStart && interval.startDay < coverageStart
        ? coverageStart
        : interval.startDay;
    const end = interval.endDay < tomorrow ? interval.endDay : tomorrow;
    const rows = await all(
      `SELECT CAST(day AS VARCHAR) AS day, ${SITE_DAY_METRICS.join(", ")}
       FROM ${file("site_days")} WHERE ${where} AND ${within(interval)}`,
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const days = [];
    if (coverageStart !== null)
      for (let day = start; day < end; day = addDays(day, 1))
        days.push({ day, ...metricsOf(byDay.get(day)) });
    const total = metricsOf({});
    for (const r of rows)
      for (const m of SITE_DAY_METRICS) total[m] += Number(r[m]);
    const { change } = await comparison(interval, where);
    return {
      site: { siteId: req.siteId },
      totals: split(total),
      comparison: { change },
      days,
    };
  }

  async function issues() {
    const range = within(req.month, "createdDay");
    const [{ n }] = await all(
      `SELECT count(*) AS n FROM ${file("issues")} WHERE ${range}`,
    );
    const columns = Object.entries(TABLE_SCHEMAS.issues)
      .map(([c, type]) =>
        type === "DATE" ? `CAST(i.${c} AS VARCHAR) AS ${c}` : `i.${c}`,
      )
      .join(", ");
    // createdAt desc, then Site and Issue ID: read-model.js's default order.
    const page = await all(
      `SELECT ${columns}, s.name AS siteName
       FROM ${file("issues")} AS i LEFT JOIN ${file("sites")} AS s USING (siteId)
       WHERE ${range}
       ORDER BY i.createdAt DESC NULLS LAST, i.siteId, i.issueId
       LIMIT ${req.issueList.limit}`,
    );
    return { total: Number(n), issues: page };
  }

  /** @type {Record<string, () => Promise<any>>} */
  const queries = { overview, trends, site, issues };
  return {
    run: (/** @type {string} */ q) => queries[q](),
    close: () => {
      conn.closeSync();
      instance.closeSync();
    },
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
 * @param {{ runs: number, threads: number }} opts
 */
export async function measure(query, dir, { runs, threads }) {
  let peakHeap = 0;
  const sample = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  const impl = await designB(dir, requests(manifest), threads);
  try {
    await impl.run(query);
    // performance.now() counts from process start, so this includes imports.
    const coldMs = performance.now();
    sample();
    /** @type {number[]} */
    const times = [];
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now();
      await impl.run(query);
      times.push(performance.now() - started);
      sample();
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
  } finally {
    impl.close();
  }
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
  const manifest = JSON.parse(
    await readFile(join(base, "manifest.json"), "utf8"),
  );
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
         (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP})`,
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
        { ...manifest, rowCounts, bench: { sites, years, copies, span } },
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
 * @param {{ runs: number, threads: number }} opts
 * @returns {Promise<Record<string, any>>}
 */
function runChild(query, dir, { runs, threads }) {
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
        "--threads",
        String(threads),
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
 * @param {{ dir?: string, sites: string, years: string, runs: string, threads: string, rebuild?: boolean, json?: string }} opts
 * @param {string} [benchDir] where sized copies are built
 * @returns {Promise<Record<string, any>[]>} one result per size and query
 */
export async function main(opts, benchDir = BENCH_DIR) {
  const sizes = wholeNumbers(opts.sites, "--sites");
  const yearsList = wholeNumbers(opts.years, "--years");
  const [runs] = wholeNumbers(opts.runs, "--runs");
  const [threads] = wholeNumbers(opts.threads, "--threads");
  const dataDir = opts.dir ?? DATA_DIR;
  const base = join(dataDir, "projection");
  if (!existsSync(join(base, "manifest.json")))
    throw new Error(
      `no projection in ${dataDir}; run npm run insights:data -w backend first`,
    );
  const baseManifest = JSON.parse(
    await readFile(join(base, "manifest.json"), "utf8"),
  );
  /** @type {Record<string, any>[]} */
  const results = [];
  for (const sites of sizes)
    for (const years of yearsList) {
      const label = `${sites} Sites, ${years} year${years > 1 ? "s" : ""}`;
      const dir = join(benchDir, `${sites}-sites-${years}y`);
      const stamp = existsSync(join(dir, "manifest.json"))
        ? JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))
        : null;
      if (opts.rebuild || stamp?.snapshotId !== baseManifest.snapshotId) {
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
        const r = await runChild(query, dir, { runs, threads });
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
      threads: { type: "string", default: "1" },
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
      threads: Number(args.threads),
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
