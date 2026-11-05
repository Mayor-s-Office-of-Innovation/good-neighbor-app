// Times three ways to read Insights data and how much memory each needs, so
// the read design can be picked on numbers. The analytics Lambda has 2 GB.
//
//   npm run insights:bench -w backend -- [--sites 500,1000] [--years 1,2] [--runs 30]
//
// Designs, each answering the same requests:
// - A: PR 3 as built. Every projection table is loaded into memory as rows
//   and indexed (snapshot.js), then read-model.js answers.
// - B: one long-lived DuckDB instance queries the Parquet files on disk per
//   request. Files are sorted by day and cut into 16,384-row groups, so a
//   period's query skips the other days' row groups and unused columns.
// - C: the architecture doc's browser file (decision 3 and 4): Arrow IPC of
//   Site-day totals plus a Site table, decoded with apache-arrow in Node as a
//   stand-in for the browser. It holds no Issue facts, so it answers Overview
//   and Trends only, without max severity or Issue categories.
// Queries: Overview and Trends for the 12 months before this month (Trends
// by department), Site detail for the same 12 months, and last month's
// first page of Issues.
//
// Input is the projection from `npm run insights:data` (24 Sites, a year).
// Sizes are made from it by copying each Site's rows under new Site IDs,
// and each extra year by copying every row with its days moved back by the
// data's span. Copies change the size, not the rules. Built files are kept in
// backend/.local/insights-bench/ and reused while the input is unchanged.
//
// Each design × query × size runs in its own Node process with
// --max-old-space-size=2048, the Lambda's memory, so one design's garbage
// can't slow another. A run whose peak RSS, native memory included, passes
// 2,048 MiB fails, as it would on the Lambda.
// All designs' answers must agree (totals, comparisons, series, page rows);
// any difference fails the run.
//
// Options:
//   --dir      insights:data output folder (default backend/.local/insights-data)
//   --sites    Site counts, comma-separated (default 500,1000)
//   --years    years of data, comma-separated (default 1,2)
//   --runs     warm runs per query after the first answer (default 30)
//   --designs  any of A,B,C (default all)
//   --threads  DuckDB threads for B (default 1; a 2 GB Lambda has about 1.2 vCPUs)
//   --rebuild  rebuild the sized files even if the input is unchanged
//   --json     also write every result to this file
//
// Columns:
//   cold ms     process start to the first answer: imports, reading the
//               files from disk, decoding or indexing, and the query
//   peak RSS    the process's peak resident memory, native memory included
//               (DuckDB's buffers count here, not in heap)
//   peak heap   the largest V8 heap in use, sampled after each step
//   warm p50    median time per answer over --runs answers, same process
//   warm p95    95th percentile of those
//   files MB    bytes on disk of the files the design reads for the query

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
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

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    sites: { type: "string", default: "500,1000" },
    years: { type: "string", default: "1,2" },
    runs: { type: "string", default: "30" },
    designs: { type: "string", default: "A,B,C" },
    threads: { type: "string", default: "1" },
    rebuild: { type: "boolean", default: false },
    json: { type: "string" },
    child: { type: "string" },
    query: { type: "string" },
    data: { type: "string" },
  },
});

const HEAP_MB = 2048;
const QUERIES = ["overview", "trends", "site", "issues"];
const QUERY_LABELS = {
  overview: "Overview, 12 months",
  trends: "Trends, 12 months",
  site: "Site detail, 12 months",
  issues: "Issues, a month",
};
// Small enough that a year of 500 Sites spans about ten groups to skip.
const ROW_GROUP = 16_384;
const C_QUERIES = new Set(["overview", "trends"]);
const NAMES = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const RUNS = Number(args.runs);
const THREADS = Number(args.threads);

/**
 * @param {string} list
 * @param {string} name
 * @returns {number[]}
 */
function wholeNumbers(list, name) {
  const xs = list.split(",").map(Number);
  if (!xs.length || xs.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error(
      `[insights-bench] ${name} must be whole numbers of 1 or more`,
    );
    process.exit(1);
  }
  return xs;
}

/** @param {Record<string, any>} row */
const metricsOf = (row) =>
  Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, Number(row?.[m] ?? 0)]));

/** @param {{ activity: Record<string, number>, response: Record<string, number> }} t */
const flat = (t) => metricsOf({ ...t.activity, ...t.response });

/**
 * The requests every design answers, from the snapshot's own clock.
 * @param {Record<string, any>} manifest
 */
function requests(manifest) {
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
function bucketRanges(interval, granularity, today) {
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
function byName(a, b) {
  for (const [x, y] of [
    [a.name ?? a.siteId, b.name ?? b.siteId],
    [a.name ?? "", b.name ?? ""],
  ]) {
    const c = NAMES.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
    if (c) return c;
  }
  return a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0;
}

// ---------------------------------------------------------------- answers
// Each design's reply reduced to what all designs must agree on (`common`)
// and what only some can give (`extra`: max severity, Issue categories).

/** @param {Record<string, any> | null} change */
const comparisonAnswer = (change) =>
  change &&
  Object.fromEntries(
    SITE_DAY_METRICS.map((m) => [m, [change[m].current, change[m].prior]]),
  );

/** @param {Record<string, any>[]} series */
const seriesAnswer = (series) =>
  series.map((b) => ({
    start: b.start,
    end: b.end,
    partial: b.partial,
    noData: b.noData,
    ...metricsOf(b),
  }));

/**
 * @param {string} query
 * @param {any} r a reply in read-model.js's shape
 */
function answerOf(query, r) {
  if (query === "overview")
    return {
      common: {
        totals: flat(r.totals),
        comparison: comparisonAnswer(r.comparison.change),
        siteCount: r.siteCount,
        page: r.sites.map((/** @type {any} */ s) => ({
          siteId: s.siteId,
          name: s.name,
          ...flat(s),
        })),
      },
      extra:
        r.sites[0]?.maxSeverity === undefined
          ? null
          : r.sites.map((/** @type {any} */ s) => s.maxSeverity),
    };
  if (query === "trends")
    return {
      common: {
        siteCount: r.scope.siteCount,
        comparison: comparisonAnswer(r.comparison.change),
        current: seriesAnswer(r.series.current),
        prior: seriesAnswer(r.series.prior),
        breakdown: r.breakdown.map((/** @type {any} */ g) => ({
          value: g.value,
          sites: g.sites,
          current: metricsOf(g.current),
          prior: g.prior && metricsOf(g.prior),
        })),
      },
      extra: r.categories ?? null,
    };
  if (query === "site")
    return {
      common: {
        siteId: r.site.siteId,
        totals: flat(r.totals),
        comparison: comparisonAnswer(r.comparison.change),
        days: r.days.map((/** @type {any} */ d) => ({
          day: d.day,
          ...metricsOf(d),
        })),
      },
      extra: null,
    };
  return {
    common: {
      total: r.total,
      page: r.issues.map((/** @type {any} */ i) => [
        i.issueId,
        i.siteId,
        i.createdAt,
        i.siteName,
      ]),
    },
    extra: null,
  };
}

// ---------------------------------------------------------------- design A

/**
 * @param {string} dir
 * @param {ReturnType<typeof requests>} req
 * @param {() => void} sample
 */
async function designA(dir, req, sample) {
  const { dirSource, indexSnapshot } = await import(
    "../src/reporting/api/snapshot.js"
  );
  const readModel = await import("../src/reporting/api/read-model.js");
  const loaded = await dirSource(dir).load(dir);
  sample();
  const snap = indexSnapshot(loaded);
  sample();
  const { year, month, now } = req;
  return {
    /** @param {string} query */
    run: async (query) =>
      query === "overview"
        ? readModel.overview(snap, {
            interval: year,
            filter: {},
            list: req.siteList,
            now,
          })
        : query === "trends"
          ? readModel.trends(snap, {
              interval: year,
              scope: {},
              breakdown: "department",
              now,
            })
          : query === "site"
            ? readModel.siteDetail(snap, req.siteId, { interval: year, now })
            : readModel.listIssues(snap, {
                interval: month,
                filter: {},
                list: req.issueList,
                now,
              }),
  };
}

// ---------------------------------------------------------------- design B

/**
 * @param {string} dir
 * @param {ReturnType<typeof requests>} req
 */
async function designB(dir, req) {
  // Imported here, not at the top, so A's and C's cold times leave it out
  // unless they load it themselves.
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:", {
    threads: String(THREADS),
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
  return { run: (/** @type {string} */ q) => queries[q]() };
}

// ---------------------------------------------------------------- design C

/**
 * @param {string} dir
 * @param {ReturnType<typeof requests>} req
 * @param {() => void} sample
 */
async function designC(dir, req, sample) {
  const { tableFromIPC } = await import("apache-arrow");
  const days = tableFromIPC(await readFile(join(dir, "site_days.arrow")));
  const sitesTable = tableFromIPC(await readFile(join(dir, "sites.arrow")));
  sample();
  if (days.batches.length !== 1)
    throw new Error("site_days.arrow must be one batch");
  const siteCol = days.getChild("siteId")?.data[0];
  const dayCol = days.getChild("day")?.data[0];
  if (!siteCol?.dictionary || !dayCol?.dictionary)
    throw new Error("bad site_days.arrow");
  const siteIdx = siteCol.values;
  const dayIdx = dayCol.values;
  /** @type {string[]} */
  const siteDict = siteCol.dictionary.toArray();
  /** @type {string[]} */
  const dayDict = dayCol.dictionary.toArray();
  const metrics = SITE_DAY_METRICS.map((m) => days.getChild(m)?.data[0].values);
  const M = metrics.length;
  const sites = sitesTable.toArray().map((r) => r.toJSON());
  const slot = new Map(siteDict.map((id, i) => [id, i]));
  const coverageStart = dayDict.length ? dayDict[0] : null;
  sample();

  // Rows are sorted by day and the dictionary in first-seen order, so day
  // indices rise with the row and a range is two binary searches.
  /** @param {string} day */
  const firstRow = (day) => {
    let lo = 0;
    let hi = dayIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dayDict[dayIdx[mid]] < day) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /**
   * @param {{ startDay: string, endDay: string }} r
   * @param {Float64Array} [perSite] nSites × M sums, added to
   */
  const sumRange = (r, perSite) => {
    const total = new Float64Array(M);
    const end = firstRow(r.endDay);
    for (let row = firstRow(r.startDay); row < end; row += 1) {
      const base = perSite ? siteIdx[row] * M : 0;
      for (let m = 0; m < M; m += 1) {
        const v = metrics[m][row];
        total[m] += v;
        if (perSite) perSite[base + m] += v;
      }
    }
    return total;
  };
  /** @param {ArrayLike<number>} xs */
  const asMetrics = (xs, at = 0) =>
    Object.fromEntries(SITE_DAY_METRICS.map((m, i) => [m, xs[at + i]]));
  /** @param {Record<string, number>} t */
  const split = (t) => ({ activity: t, response: {} });

  /** @param {{ startDay: string, endDay: string }} interval */
  function comparison(interval) {
    const cmp = comparisonFor(/** @type {any} */ (interval), req.evaluatedAt);
    if (!cmp.prior) return { cmp, change: null };
    const cur = asMetrics(sumRange(cmp.current));
    const pri = asMetrics(sumRange(cmp.prior));
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

  function overview() {
    const perSite = new Float64Array(siteDict.length * M);
    const total = asMetrics(sumRange(req.year, perSite));
    const rows = sites
      .map((s) => {
        const i = slot.get(s.siteId);
        return {
          siteId: s.siteId,
          name: s.name,
          ...split(i === undefined ? metricsOf({}) : asMetrics(perSite, i * M)),
          publicContact: s.publicContact,
          siteContact: s.siteContact,
        };
      })
      .sort(byName);
    return {
      totals: split(total),
      comparison: { change: comparison(req.year).change },
      siteCount: sites.length,
      sites: rows.slice(0, req.siteList.limit),
    };
  }

  function trends() {
    const interval = req.year;
    const granularity =
      interval.kind === "year" || interval.kind === "financialYear"
        ? "month"
        : "week";
    const prior = previousOf(interval, req.evaluatedAt);
    /** @param {{ start: string, end: string }[]} list */
    const series = (list) =>
      list.map((b) => ({
        ...b,
        partial: b.end > req.today,
        noData: coverageStart === null || b.end <= coverageStart,
        ...asMetrics(sumRange({ startDay: b.start, endDay: b.end })),
      }));
    const { cmp, change } = comparison(interval);
    const cur = new Float64Array(siteDict.length * M);
    const pri = new Float64Array(siteDict.length * M);
    sumRange(cmp.current, cur);
    if (cmp.prior) sumRange(cmp.prior, pri);
    /** @type {Map<string, { sites: number, current: Float64Array, prior: Float64Array }>} */
    const groups = new Map();
    for (const s of sites) {
      const value = s.department ?? "unknown";
      const g = groups.get(value) ?? {
        sites: 0,
        current: new Float64Array(M),
        prior: new Float64Array(M),
      };
      g.sites += 1;
      const i = slot.get(s.siteId);
      if (i !== undefined)
        for (let m = 0; m < M; m += 1) {
          g.current[m] += cur[i * M + m];
          g.prior[m] += pri[i * M + m];
        }
      groups.set(value, g);
    }
    return {
      scope: { siteCount: sites.length },
      comparison: { change },
      series: {
        current: series(bucketRanges(interval, granularity, req.today)),
        prior: series(bucketRanges(prior, granularity, req.today)),
      },
      breakdown: [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, g]) => ({
          value,
          sites: g.sites,
          current: asMetrics(g.current),
          prior: cmp.prior ? asMetrics(g.prior) : null,
        })),
    };
  }

  /** @type {Record<string, () => any>} */
  const queries = { overview, trends };
  return { run: async (/** @type {string} */ q) => queries[q]() };
}

// ---------------------------------------------------------------- child

/**
 * One design × query × size; prints one JSON line.
 * @param {string} design
 * @param {string} query
 * @param {string} dir
 */
async function child(design, query, dir) {
  let peakHeap = 0;
  const sample = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  const req = requests(manifest);
  const impl =
    design === "A"
      ? await designA(dir, req, sample)
      : design === "B"
        ? await designB(dir, req)
        : await designC(dir, req, sample);
  const first = await impl.run(query);
  // performance.now() counts from process start, so this includes imports.
  const coldMs = performance.now();
  sample();
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    await impl.run(query);
    times.push(performance.now() - started);
    sample();
  }
  times.sort((a, b) => a - b);
  const at = (/** @type {number} */ q) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))];
  process.stdout.write(
    `${JSON.stringify({
      coldMs,
      // libuv reports maxRSS in kilobytes on every platform.
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      peakHeapMiB: peakHeap / 1048576,
      warmP50: at(0.5),
      warmP95: at(0.95),
      answer: answerOf(query, first),
    })}\n`,
  );
}

// ---------------------------------------------------------------- data

/**
 * The input projection copied up to `sites` Sites and `years` years.
 * @param {string} base
 * @param {string} out
 * @param {number} sites
 * @param {number} years
 */
async function buildSize(base, out, sites, years) {
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
    const order = {
      site_days: "day, siteId",
      issues: "createdDay, siteId, issueId",
      checks: "day, siteId, checkId",
      sites: "siteId",
      site_contacts: "siteId",
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
           ORDER BY ${/** @type {Record<string, string>} */ (order)[name]})
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
    await writeArrowFiles(conn, tmp);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  await rm(out, { recursive: true, force: true });
  await rename(tmp, out);
}

/**
 * Design C's files: Site-day totals with dictionary-coded Site IDs and days
 * and 16-bit counts, plus the Site table with contact states.
 * @param {any} conn
 * @param {string} dir
 */
async function writeArrowFiles(conn, dir) {
  const arrow = await import("apache-arrow");
  const {
    Dictionary,
    Int16,
    Int32,
    Table,
    Utf8,
    makeVector,
    tableToIPC,
    vectorFromArray,
  } = arrow;
  const file = (/** @type {string} */ n) =>
    `read_parquet(${sqlString(join(dir, `${n}.parquet`))})`;
  const days = (
    await conn.runAndReadAll(
      `SELECT siteId, CAST(day AS VARCHAR) AS day, ${SITE_DAY_METRICS.join(", ")}
       FROM ${file("site_days")} ORDER BY day, siteId`,
    )
  ).getColumnsObjectJS();
  /** @param {unknown[]} xs */
  const dict = (xs) =>
    vectorFromArray(
      xs,
      new Dictionary(
        new Utf8(),
        new Set(xs).size < 32_768 ? new Int16() : new Int32(),
      ),
    );
  /** @type {Record<string, any>} */
  const cols = { siteId: dict(days.siteId), day: dict(days.day) };
  for (const m of SITE_DAY_METRICS) {
    // A Site never logs 32,767 of anything in a day; check rather than wrap.
    if (days[m].some((/** @type {number} */ v) => v > 32_767))
      throw new Error(`${m} does not fit 16 bits`);
    cols[m] = makeVector(Int16Array.from(days[m]));
  }
  await writeFile(
    join(dir, "site_days.arrow"),
    tableToIPC(new Table(cols), "file"),
  );
  const sites = (
    await conn.runAndReadAll(
      `SELECT s.siteId, s.name, s.status, s.siteType, s.providerId, s.programId,
         s.department, s.managerId, c.publicContact, c.siteContact
       FROM ${file("sites")} AS s LEFT JOIN ${file("site_contacts")} AS c USING (siteId)
       ORDER BY s.siteId`,
    )
  ).getColumnsObjectJS();
  await writeFile(
    join(dir, "sites.arrow"),
    tableToIPC(
      new Table(
        Object.fromEntries(
          Object.entries(sites).map(([k, v]) => [
            k,
            vectorFromArray(v, new Utf8()),
          ]),
        ),
      ),
      "file",
    ),
  );
}

/**
 * @param {string} dir
 * @param {string[]} names
 */
async function bytesOf(dir, names) {
  let n = 0;
  for (const name of names) n += (await stat(join(dir, name))).size;
  return n;
}

/** Bytes the browser would add for the decoder: the one import C uses. */
async function decoderSize() {
  const { build } = await import("esbuild");
  const result = await build({
    stdin: {
      contents: `import { tableFromIPC } from "apache-arrow"; export const decode = (b) => tableFromIPC(b);`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const code = Buffer.from(result.outputFiles[0].contents);
  return {
    minKB: code.length / 1024,
    gzipKB: gzipSync(code).length / 1024,
    brotliKB: brotliCompressSync(code).length / 1024,
  };
}

/**
 * @param {string} dir
 * @param {string} design
 * @param {string} query
 */
async function fileBytes(dir, design, query) {
  if (design === "A")
    return bytesOf(
      dir,
      Object.keys(TABLE_SCHEMAS).map((n) => `${n}.parquet`),
    );
  if (design === "C") return bytesOf(dir, ["site_days.arrow", "sites.arrow"]);
  const tables = {
    overview: ["site_days", "issues", "sites"],
    trends: ["site_days", "issues", "sites"],
    site: ["site_days", "sites"],
    issues: ["issues", "sites"],
  };
  return bytesOf(
    dir,
    /** @type {Record<string, string[]>} */ (tables)[query].map(
      (n) => `${n}.parquet`,
    ),
  );
}

/**
 * @param {string} design
 * @param {string} query
 * @param {string} dir
 * @returns {Promise<Record<string, any>>}
 */
function runChild(design, query, dir) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MB}`,
        fileURLToPath(import.meta.url),
        "--child",
        design,
        "--query",
        query,
        "--data",
        dir,
        "--runs",
        String(RUNS),
        "--threads",
        String(THREADS),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (b) => (out += b));
    proc.stderr.on("data", (b) => (err += b));
    proc.on("error", (e) =>
      resolve({ ok: false, failure: "could not start", detail: e.message }),
    );
    proc.on("close", (code, signal) => {
      const line = out.trim().split("\n").at(-1);
      /** @type {any} */
      let result = null;
      try {
        if (code === 0 && line) result = JSON.parse(line);
      } catch {
        // A stray stdout line; reported below as a failure.
      }
      if (result && result.peakRssMiB > HEAP_MB)
        return resolve({
          ok: false,
          failure: `peak RSS ${Math.round(result.peakRssMiB)} MiB, over the Lambda's ${HEAP_MB}`,
          detail: "",
        });
      if (result) return resolve({ ok: true, ...result });
      const oom = /heap out of memory|Allocation failed/i.test(err);
      // The message comes before the stack; the last lines are frames.
      const lines = err.trim().split("\n");
      const message = lines.filter((l) => /error/i.test(l)).slice(0, 2);
      resolve({
        ok: false,
        failure: oom
          ? `out of memory at ${HEAP_MB} MiB heap`
          : `exit ${code ?? signal}`,
        detail: (message.length ? message : lines.slice(0, 3)).join(" "),
      });
    });
  });
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} [path]
 * @returns {string | null} where the two first differ
 */
function firstDifference(a, b, path = "") {
  if (a === b) return null;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return `${path || "value"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDifference(
      /** @type {any} */ (a)[k],
      /** @type {any} */ (b)[k],
      `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`,
    );
    if (d) return d;
  }
  return null;
}

async function main() {
  const sizes = wholeNumbers(args.sites, "--sites");
  const yearsList = wholeNumbers(args.years, "--years");
  wholeNumbers(args.runs, "--runs");
  wholeNumbers(args.threads, "--threads");
  const designs = args.designs.split(",").map((s) => s.trim().toUpperCase());
  if (designs.some((x) => !["A", "B", "C"].includes(x))) {
    console.error("[insights-bench] --designs takes A, B and C");
    process.exit(1);
  }
  const dataDir =
    args.dir ??
    fileURLToPath(new URL("../.local/insights-data", import.meta.url));
  const base = join(dataDir, "projection");
  if (!existsSync(join(base, "manifest.json"))) {
    console.error(
      `[insights-bench] no projection in ${dataDir}; run npm run insights:data -w backend first`,
    );
    process.exit(1);
  }
  const baseManifest = JSON.parse(
    await readFile(join(base, "manifest.json"), "utf8"),
  );
  const benchDir = fileURLToPath(
    new URL("../.local/insights-bench", import.meta.url),
  );
  const decoder = designs.includes("C") ? await decoderSize() : null;
  /** @type {Record<string, any>[]} */
  const results = [];
  const problems = [];
  for (const sites of sizes)
    for (const years of yearsList) {
      const label = `${sites} Sites, ${years} year${years > 1 ? "s" : ""}`;
      const dir = join(benchDir, `${sites}-sites-${years}y`);
      const stamp = existsSync(join(dir, "manifest.json"))
        ? JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))
        : null;
      if (args.rebuild || stamp?.snapshotId !== baseManifest.snapshotId) {
        const started = performance.now();
        await buildSize(base, dir, sites, years);
        console.log(
          `[insights-bench] built ${label} in ${((performance.now() - started) / 1000).toFixed(1)} s`,
        );
      }
      const { rowCounts } = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8"),
      );
      const arrowBytes = await readFile(join(dir, "site_days.arrow"));
      console.log(
        `[insights-bench] ${label}: ${Object.entries(rowCounts)
          .map(([k, v]) => `${k} ${v}`)
          .join(
            ", ",
          )}; site_days.arrow ${(arrowBytes.length / 1e6).toFixed(2)} MB, ${(gzipSync(arrowBytes).length / 1e6).toFixed(2)} MB gzip, ${(brotliCompressSync(arrowBytes).length / 1e6).toFixed(2)} MB brotli`,
      );
      for (const query of QUERIES) {
        /** @type {Record<string, any>} */
        const byDesign = {};
        for (const design of designs) {
          if (design === "C" && !C_QUERIES.has(query)) continue;
          const r = await runChild(design, query, dir);
          r.fileMB = (await fileBytes(dir, design, query)) / 1e6;
          byDesign[design] = r;
          results.push({
            size: label,
            sites,
            years,
            design,
            query,
            ...r,
            answer: undefined,
          });
        }
        // Every design that answered must give the same numbers.
        const answered = Object.entries(byDesign).filter(([, r]) => r.ok);
        const [refName, ref] = answered[0] ?? [];
        // C has no extras, so A and B compare them with whichever came first.
        const [extraName, extraRef] =
          answered.find(([, r]) => r.answer.extra) ?? [];
        for (const [design, r] of answered) {
          const common =
            design !== refName &&
            firstDifference(ref.answer.common, r.answer.common);
          if (common)
            problems.push(
              `${label}, ${query}: ${refName} and ${design} differ at ${common}`,
            );
          const extra =
            design !== extraName &&
            r.answer.extra &&
            firstDifference(extraRef.answer.extra, r.answer.extra);
          if (extra)
            problems.push(
              `${label}, ${query}: ${extraName} and ${design} differ at ${extra}`,
            );
        }
        if (answered.length > 1)
          console.log(
            `[insights-bench] ${label}, ${query}: ${answered.map(([d]) => d).join(", ")} checked for the same answer`,
          );
      }
      const rows = results.filter((r) => r.size === label);
      console.log(`\n${label}`);
      console.table(
        Object.fromEntries(
          rows.map((r) => [
            `${r.design} ${QUERY_LABELS[/** @type {keyof typeof QUERY_LABELS} */ (r.query)]}`,
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
  if (decoder)
    console.log(
      `[insights-bench] C's decoder (tableFromIPC), esbuild-minified for the browser: ${decoder.minKB.toFixed(0)} kB, ${decoder.gzipKB.toFixed(0)} kB gzip, ${decoder.brotliKB.toFixed(0)} kB brotli`,
    );
  if (args.json)
    await writeFile(args.json, JSON.stringify({ decoder, results }, null, 2));
  for (const r of results)
    if (!r.ok) {
      console.error(
        `[insights-bench] ${r.size}, ${r.design} ${r.query}: ${r.failure}. ${r.detail}`,
      );
      process.exitCode = 1;
    }
  if (problems.length) {
    for (const p of problems) console.error(`[insights-bench] ${p}`);
    console.error(
      "[insights-bench] designs disagree; the timings above don't compare like with like",
    );
    process.exitCode = 1;
  } else
    console.log(
      "[insights-bench] every design that answered gave the same numbers",
    );
}

if (args.child) {
  if (!args.query || !args.data)
    throw new Error("--child needs --query and --data");
  await child(args.child, args.query, args.data);
} else await main();
