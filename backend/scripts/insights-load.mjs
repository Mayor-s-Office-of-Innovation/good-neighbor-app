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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    copies: { type: "string", default: "1" },
    rounds: { type: "string", default: "20" },
    parallel: { type: "string", default: "10" },
  },
});
const dataDir =
  args.dir ??
  fileURLToPath(new URL("../.local/insights-data", import.meta.url));
const COPIES = Number(args.copies);
const ROUNDS = Number(args.rounds);
const PARALLEL = Number(args.parallel);
for (const [name, n] of Object.entries({ COPIES, ROUNDS, PARALLEL }))
  if (!Number.isInteger(n) || n < 1) {
    console.error(
      `[insights-load] ${name.toLowerCase()} must be a whole number of 1 or more`,
    );
    process.exit(1);
  }

/**
 * @param {Record<string, Record<string, any>[]>} tables
 * @param {number} copies
 */
function multiply(tables, copies) {
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

const source = dirSource(join(dataDir, "projection"));
const loadStarted = performance.now();
const latest = await source.latest();
if (!latest) {
  console.error(
    `[insights-load] no projection in ${dataDir}; run npm run insights:data -w backend first`,
  );
  process.exit(1);
}
const loaded = await source.load(latest.prefix);
const tables = multiply(loaded.tables, COPIES);
/** @type {{ ownerKey: string, jobId: string }[]} */
const queued = [];
const jobStore = memoryJobStore();
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
  jobStore,
  starter: async (ref) => {
    queued.push(ref);
  },
});

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
    headers: {
      "idempotency-key": `load-${Math.random().toString(36).slice(2)}`,
    },
    ...o,
  });
const evaluatedAt = loaded.manifest.evaluatedAt;
// Pacific days, as the API reads them; UTC slicing is a day off at night.
const today = pacificDateKey(evaluatedAt);
const thisMonth = addMonthsToFirst(today, 0);
const month = {
  period: "month",
  month: addMonthsToFirst(today, -1).slice(0, 7),
};
const year = {
  period: "custom",
  from: addMonthsToFirst(today, -12),
  to: thisMonth,
};
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
 * @param {number[]} xs
 * @param {number} q
 */
const quantile = (xs, q) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(q * xs.length))
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
  for (let round = 0; round < ROUNDS; round += 1) {
    const started = performance.now();
    await Promise.all(Array.from({ length: PARALLEL }, call));
    times.push((performance.now() - started) / PARALLEL);
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
if (COPIES === 1) {
  // The generator's own answers, not the projection's sums of them.
  const answers = JSON.parse(
    await readFile(join(dataDir, "answers.json"), "utf8"),
  );
  /** @type {Record<string, number>} */
  const want = {};
  for (const month of Object.values(answers.bySiteMonth ?? {}))
    for (const [metric, n] of Object.entries(/** @type {any} */ (month)))
      if (typeof n === "number") want[metric] = (want[metric] ?? 0) + n;
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
    const group = metric in parts[0].totals.activity ? "activity" : "response";
    const got = parts[0].totals[group][metric] + parts[1].totals[group][metric];
    if (got === want[metric]) matched += 1;
    else problems.push(`${metric}: Overview ${got}, generator ${want[metric]}`);
  }
  console.log(
    `[insights-load] whole year through Overview: ${matched} of ${metrics.length} totals match the generator's answers`,
  );
}
console.log(
  `[insights-load] export job: ${done.result?.rows} rows, ${((done.result?.bytes ?? 0) / 1e6).toFixed(1)} MB, built in ${exportMs.toFixed(0)} ms`,
);
if (problems.length) {
  for (const p of problems) console.error(`[insights-load] ${p}`);
  process.exitCode = 1;
} else
  console.log(
    "[insights-load] Overview, Issues list and CSV export agree on every count checked",
  );
