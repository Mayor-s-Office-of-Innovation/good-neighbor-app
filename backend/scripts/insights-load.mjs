// Times every Insights endpoint against the synthetic year from
// `npm run insights:data`, and checks the endpoints agree with each other
// and with the generator's answers.
//
//   npm run insights:load -w backend -- [--copies 21] [--rounds 20] [--parallel 10]
//
// --copies repeats each synthetic Site under new IDs, so 24 Sites become
// about 500, the city's count. Copies change only the size, not the rules.
// Each round runs --parallel calls at once; a round's time per call is one
// sample, and the table gives the median and slowest of those samples.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createReportingHandlers } from "../src/handlers/admin-reporting.js";
import {
  addDays,
  addMonthsToFirst,
  pacificDateKey,
} from "../src/lib/pacific-dates.js";
import { memoryJobStore } from "../src/reporting/api/jobs.js";
import {
  createSnapshotStore,
  dirSource,
} from "../src/reporting/api/snapshot.js";

/**
 * @param {Record<string, string>} counts option name to its value
 * @returns {Record<string, number>}
 */
export function wholeCounts(counts) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [name, value] of Object.entries(counts)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`--${name} must be a whole number of 1 or more`);
    out[name] = n;
  }
  return out;
}

/**
 * @param {Record<string, Record<string, any>[]>} tables
 * @param {number} copies
 */
export function multiply(tables, copies) {
  if (copies <= 1) return tables;
  /** @type {Record<string, Record<string, any>[]>} */
  const out = {};
  for (const [name, rows] of Object.entries(tables))
    out[name] = rows.flatMap((row) =>
      Array.from({ length: copies }, (_, n) =>
        n === 0
          ? row
          : {
              ...row,
              siteId: `${row.siteId}-copy${n}`,
              ...(row.issueId ? { issueId: `${row.issueId}-copy${n}` } : {}),
              ...(row.checkId ? { checkId: `${row.checkId}-copy${n}` } : {}),
              ...(name === "sites" ? { name: `${row.name} (copy ${n})` } : {}),
            },
      ),
    );
  return out;
}

/**
 * Last month and the 12 months before this one, from the snapshot's clock.
 * @param {string} evaluatedAt
 */
export function periods(evaluatedAt) {
  // Pacific days, as the API reads them; UTC slicing is a day off at night.
  const today = pacificDateKey(evaluatedAt);
  return {
    today,
    month: { period: "month", month: addMonthsToFirst(today, -1).slice(0, 7) },
    year: {
      period: "custom",
      from: addMonthsToFirst(today, -12),
      to: addMonthsToFirst(today, 0),
    },
  };
}

/**
 * Each metric's total over every Site and month of the generator's answers.
 * @param {{ bySiteMonth?: Record<string, Record<string, unknown>> }} answers
 * @returns {Record<string, number>}
 */
export function answerTotals(answers) {
  /** @type {Record<string, number>} */
  const want = {};
  for (const month of Object.values(answers.bySiteMonth ?? {}))
    for (const [metric, n] of Object.entries(month))
      if (typeof n === "number") want[metric] = (want[metric] ?? 0) + n;
  return want;
}

/**
 * @param {number[]} xs
 * @param {number} q
 */
export const quantile = (xs, q) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(q * xs.length))
  ];

/**
 * @param {any} res
 * @param {string} label
 * @returns {any} the reply, if it succeeded
 */
function ok(res, label) {
  if (res.statusCode >= 300)
    throw new Error(`${label}: ${res.statusCode} ${res.body}`);
  return res;
}

/**
 * @param {{ dataDir: string, copies: number, rounds: number, parallel: number }} opts
 * @returns {Promise<{ sites: number, timings: Record<string, { p50: number, max: number, bytes: number }>, problems: string[] }>}
 */
export async function runLoad({ dataDir, copies, rounds, parallel }) {
  const source = dirSource(join(dataDir, "projection"));
  const loadStarted = performance.now();
  const latest = await source.latest();
  if (!latest)
    throw new Error(
      `no projection in ${dataDir}; run npm run insights:data -w backend first`,
    );
  const loaded = await source.load(latest.prefix);
  const tables = multiply(loaded.tables, copies);
  /** @type {{ ownerKey: string, jobId: string }[]} */
  const queued = [];
  const snapshots = createSnapshotStore({
    source: {
      latest: async () => latest,
      load: async () => ({ ...loaded, tables }),
    },
  });
  // Index now, so the time and heap below include the copies' lookups.
  const snap = await snapshots.current();
  const loadMs = performance.now() - loadStarted;
  const h = createReportingHandlers({
    snapshots,
    jobStore: memoryJobStore(),
    starter: async (ref) => {
      queued.push(ref);
    },
  });

  let requestCount = 0;
  /** @param {Record<string, unknown>} [o] */
  const event = (o = {}) =>
    /** @type {any} */ ({
      requestContext: {
        authorizer: {
          jwt: {
            claims: { "cognito:groups": "compliance-manager", sub: "load" },
          },
        },
      },
      // A new key per call, so no export request replays an earlier job.
      headers: { "idempotency-key": `load-call-${(requestCount += 1)}` },
      ...o,
    });
  const { today, month, year } = periods(loaded.manifest.evaluatedAt);
  const firstSite = tables.sites[0].siteId;
  const firstIssue = tables.issues[0].issueId;
  const firstCheck = tables.checks[0].checkId;

  /** @type {[string, () => Promise<any>][]} */
  const calls = [
    [
      "overview, month",
      () => h.getOverview(event({ queryStringParameters: month })),
    ],
    [
      "overview, 12 months",
      () => h.getOverview(event({ queryStringParameters: year })),
    ],
    [
      "site detail, 12 months",
      () =>
        h.getSite(
          event({
            pathParameters: { siteId: firstSite },
            queryStringParameters: year,
          }),
        ),
    ],
    [
      "issues, month",
      () => h.listIssues(event({ queryStringParameters: month })),
    ],
    [
      "issues, 12 months, severe",
      () =>
        h.listIssues(
          event({ queryStringParameters: { ...year, severityBand: "severe" } }),
        ),
    ],
    [
      "issue detail",
      () => h.getIssue(event({ pathParameters: { issueId: firstIssue } })),
    ],
    [
      "checks, month",
      () => h.listChecks(event({ queryStringParameters: month })),
    ],
    [
      "check detail",
      () => h.getCheck(event({ pathParameters: { checkId: firstCheck } })),
    ],
    ["scope options", () => h.getScopeOptions(event())],
    [
      "trends, 12 months, citywide by department",
      () =>
        h.postTrends(
          event({ body: JSON.stringify({ ...year, breakdown: "department" }) }),
        ),
    ],
    [
      "export request, 12 months of Issues",
      () =>
        h.postExport(
          event({ body: JSON.stringify({ dataset: "issues", ...year }) }),
        ),
    ],
  ];

  console.log(
    `[insights-load] ${tables.sites.length} Sites, ${tables.issues.length} Issues, ${tables.checks.length} Checks; snapshot read and indexed in ${loadMs.toFixed(0)} ms`,
  );
  console.log(
    `[insights-load] heap after load: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`,
  );
  /** @type {Record<string, { p50: number, max: number, bytes: number }>} */
  const timings = {};
  for (const [label, call] of calls) {
    const first = ok(await call(), label);
    /** @type {number[]} */
    const times = [];
    for (let round = 0; round < rounds; round += 1) {
      const started = performance.now();
      await Promise.all(Array.from({ length: parallel }, call));
      times.push((performance.now() - started) / parallel);
    }
    timings[label] = {
      p50: quantile(times, 0.5),
      max: Math.max(...times),
      bytes: Buffer.byteLength(first.body),
    };
  }
  console.table(
    Object.fromEntries(
      Object.entries(timings).map(([k, t]) => [
        k,
        {
          "median ms/call": t.p50.toFixed(1),
          "slowest ms/call": t.max.toFixed(1),
          "reply kB": (t.bytes / 1024).toFixed(1),
        },
      ]),
    ),
  );

  // The numbers must agree everywhere: Overview, Issues list, export and answers.
  const body = (/** @type {any} */ res, /** @type {string} */ label) =>
    JSON.parse(ok(res, label).body);
  const yearOverview = body(
    await h.getOverview(event({ queryStringParameters: year })),
    "year overview",
  );
  const yearIssues = body(
    await h.listIssues(event({ queryStringParameters: year })),
    "year issues",
  );
  const exportJob = body(
    await h.postExport(
      event({ body: JSON.stringify({ dataset: "issues", ...year }) }),
    ),
    "year export",
  ).job;
  const exportStarted = performance.now();
  await h.runJob(queued.at(-1) ?? { ownerKey: "", jobId: "" });
  const exportMs = performance.now() - exportStarted;
  const done = body(
    await h.getJob(event({ pathParameters: { jobId: exportJob.jobId } })),
    "export job",
  ).job;
  const problems = [];
  if (yearOverview.totals.activity.issuesCreated !== yearIssues.total)
    problems.push(
      `Overview counts ${yearOverview.totals.activity.issuesCreated} Issues, the list ${yearIssues.total}`,
    );
  if (done.state !== "succeeded" || done.result.rows !== yearIssues.total)
    problems.push(
      `export holds ${done.result?.rows} rows, the list ${yearIssues.total}`,
    );
  if (copies === 1) {
    // The generator's own answers, not the projection's sums of them.
    const want = answerTotals(
      JSON.parse(await readFile(join(dataDir, "answers.json"), "utf8")),
    );
    const metrics = Object.keys(want);
    if (!metrics.length) problems.push("answers.json has no monthly answers");
    // The year runs past 12 months by a few days, so ask for it in two parts.
    const parts = await Promise.all(
      [
        { period: "custom", from: snap.coverageStart, to: year.to },
        { period: "custom", from: year.to, to: addDays(today, 1) },
      ].map(async (q, i) =>
        body(
          await h.getOverview(event({ queryStringParameters: q })),
          `whole year, part ${i + 1}`,
        ),
      ),
    );
    let matched = 0;
    for (const metric of metrics) {
      const group =
        metric in parts[0].totals.activity ? "activity" : "response";
      const got =
        parts[0].totals[group][metric] + parts[1].totals[group][metric];
      if (got === want[metric]) matched += 1;
      else
        problems.push(`${metric}: Overview ${got}, generator ${want[metric]}`);
    }
    console.log(
      `[insights-load] whole year through Overview: ${matched} of ${metrics.length} totals match the generator's answers`,
    );
  }
  console.log(
    `[insights-load] export job: ${done.result?.rows} rows, ${((done.result?.bytes ?? 0) / 1e6).toFixed(1)} MB, built in ${exportMs.toFixed(0)} ms`,
  );
  return { sites: tables.sites.length, timings, problems };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: args } = parseArgs({
    options: {
      dir: { type: "string" },
      copies: { type: "string", default: "1" },
      rounds: { type: "string", default: "20" },
      parallel: { type: "string", default: "10" },
    },
  });
  try {
    const { problems } = await runLoad({
      dataDir:
        args.dir ??
        fileURLToPath(new URL("../.local/insights-data", import.meta.url)),
      ...wholeCounts({
        copies: args.copies,
        rounds: args.rounds,
        parallel: args.parallel,
      }),
    });
    for (const p of problems) console.error(`[insights-load] ${p}`);
    if (problems.length) process.exitCode = 1;
    else
      console.log(
        "[insights-load] Overview, Issues list and CSV export agree on every count checked",
      );
  } catch (e) {
    console.error(`[insights-load] ${/** @type {Error} */ (e).message}`);
    process.exitCode = 1;
  }
}
