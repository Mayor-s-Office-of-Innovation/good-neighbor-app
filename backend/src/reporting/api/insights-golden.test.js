// Every Insights reply byte for byte, recorded from the in-memory reader, so a
// new reader can't change a number, a key's order or a sort without failing here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createReportingHandlers } from "../../handlers/admin-reporting.js";
import { buildProjection } from "../projection.js";
import { memoryJobStore } from "./jobs.js";
import { SITE_DIMENSIONS, SORTS } from "./requests.js";
import { createSnapshotStore, dirSource } from "./snapshot.js";
import {
  TEST_AS_OF,
  TEST_EVALUATED_AT,
  syntheticInputs,
} from "./test-projection.js";

const NOW = Date.parse("2026-11-04T20:00:00.000Z");
const FY = { period: "financialYear", startYear: "2026" };
const OCTOBER = { period: "month", month: "2026-10" };

/**
 * @param {string} siteId
 * @param {Record<string, any>} extra
 */
const site = (siteId, extra) => ({
  siteId,
  status: "active",
  siteType: "shelter",
  providerId: "v3",
  leadProgramId: "p3",
  oversight: {
    managingCityDepartment: "Example Department",
    cityProgramManagerId: "pm3",
  },
  location: { latitude: 37.78, longitude: -122.42 },
  perimeter: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...extra,
});

/**
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} completedAt
 */
const check = (siteId, checkId, completedAt) => ({
  siteId,
  checkId,
  status: "completed",
  flowType: "perimeter",
  startedAt: new Date(Date.parse(completedAt) - 600_000).toISOString(),
  completedAt,
  synthesizedAt: null,
});

/**
 * @param {string} siteId
 * @param {string} taskId
 * @param {string} createdAt
 * @param {Record<string, any>} extra
 */
const task = (siteId, taskId, createdAt, extra) => ({
  siteId,
  taskId,
  status: "open",
  createdAt,
  category: "Debris",
  severity: 2,
  kind: "onsite",
  type: "onsite",
  checkId: null,
  assessmentId: null,
  conditionId: null,
  inProgressAt: null,
  completedAt: null,
  resolvedAt: null,
  updatedAt: createdAt,
  ...extra,
});

// The edges a SQL reader could answer differently: names that sort alike, an
// ID two Sites share, a blank name and category, and a non-ASCII category.
/** @returns {import("../projection.js").ProjectionInputs} */
function goldenInputs() {
  const base = syntheticInputs();
  const sites = [
    site("s4", { name: null, createdAt: "2026-10-15T00:00:00.000Z" }),
    site("s5", { name: "Site 9", perimeter: "North fence" }),
    site("s6", {
      name: "site 9",
      perimeter: "South fence",
      providerId: "v1",
      publicContact: { email: "front@example.org" },
    }),
    site("s7", { name: "Site 10", siteType: "drop_in" }),
  ];
  return {
    ...base,
    sites: [...(base.sites ?? []), ...sites],
    checks: [
      ...(base.checks ?? []),
      // Shares s1's Check ID and time, so detail needs the Site and sorts tie.
      check("s5", "c1", "2026-10-02T17:00:00.000Z"),
      check("s5", "c9", "2026-10-12T17:00:00.000Z"),
      // Raises no Issue.
      check("s6", "c10", "2026-10-14T17:00:00.000Z"),
      check("s4", "c11", "2026-10-20T17:00:00.000Z"),
    ],
    tasks: [
      ...(base.tasks ?? []),
      // Shares s1's Issue ID and created time.
      task("s5", "t1", "2026-10-02T17:00:00.000Z", {
        checkId: "c1",
        severity: 4,
        category: "Unsecured gate",
      }),
      // Answered on time but open past 14 days: long unresolved.
      task("s5", "t7", "2026-10-01T16:00:00.000Z", {
        checkId: "c1",
        status: "in_progress",
        inProgressAt: "2026-10-02T16:00:00.000Z",
        category: "Café débris",
      }),
      // No severity and no category.
      task("s5", "t8", "2026-10-12T17:00:00.000Z", {
        checkId: "c9",
        severity: null,
        category: "",
      }),
      // Resolved, but 20 days after it was raised.
      task("s6", "t9", "2026-10-14T18:00:00.000Z", {
        severity: 5,
        category: "Café débris",
        status: "completed",
        inProgressAt: "2026-10-14T19:00:00.000Z",
        completedAt: "2026-11-03T18:00:00.000Z",
        resolvedAt: "2026-11-03T18:00:00.000Z",
      }),
      task("s4", "t10", "2026-10-20T17:00:00.000Z", {
        checkId: "c11",
        severity: 3,
      }),
    ],
    // s7 has no terms, so it owes nothing.
    terms: [
      ...(base.terms ?? []),
      ...["s4", "s5"].map((siteId) => ({
        siteId,
        termsVersionId: `v-${siteId}`,
        effectiveStart: "2026-01-01",
        requiredChecksPerDay: 3,
        status: "active",
      })),
      {
        siteId: "s6",
        termsVersionId: "v-s6",
        effectiveStart: "2026-10-10",
        requiredChecksPerDay: 2,
        status: "active",
      },
    ],
    asOf: TEST_AS_OF,
  };
}

/** @type {string} */
let root;
/** @type {ReturnType<typeof createReportingHandlers>} */
let h;
/** @type {ReturnType<typeof memoryJobStore>} */
let jobStore;
/** @type {{ ownerKey: string, jobId: string }[]} */
const started = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "insights-golden-"));
  const dir = join(root, "projection");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await buildProjection(conn, dir, {
      evaluatedAt: TEST_EVALUATED_AT,
      snapshotId: "golden1",
      inputs: goldenInputs(),
    });
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  jobStore = memoryJobStore();
  h = createReportingHandlers({
    snapshots: createSnapshotStore({ source: dirSource(dir) }),
    jobStore,
    starter: async (ref) => {
      started.push(ref);
    },
    now: () => NOW,
  });
});

afterAll(async () => {
  await h.close();
  await rm(root, { recursive: true, force: true });
});

/**
 * @param {{ query?: Record<string, string>, body?: unknown, path?: Record<string, string>, key?: string }} [opts]
 * @returns {any}
 */
const event = ({ query, body, path, key } = {}) => ({
  requestContext: {
    authorizer: {
      jwt: { claims: { "cognito:groups": "compliance-manager", sub: "m1" } },
    },
  },
  queryStringParameters: query,
  pathParameters: path,
  headers: key ? { "idempotency-key": key } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});

// The folder name is random per run, so it can't be part of a recorded reply.
/** @param {string} text */
const masked = (text) => text.replaceAll(root, "<dir>");

/** @typedef {[string, () => Promise<{ statusCode: number, body: string }>]} Case */

/**
 * @param {string} file
 * @param {Case[]} cases
 */
async function expectGolden(file, cases) {
  const out = [];
  for (const [name, run] of cases) {
    const res = await run();
    out.push(`## ${name} -> ${res.statusCode}`, masked(res.body));
  }
  await expect(`${out.join("\n")}\n`).toMatchFileSnapshot(
    `./__golden__/${file}.txt`,
  );
}

/**
 * @param {string} name
 * @param {Record<string, string>} query
 * @returns {Case}
 */
const overviewCase = (name, query) => [
  name,
  () => h.getOverview(event({ query })),
];

/**
 * @param {"listIssues" | "listChecks"} route
 * @param {Record<string, string>} query
 * @returns {Case[]}
 */
function pages(route, query) {
  /** @type {Case[]} */
  const cases = [];
  /** @type {string | undefined} */
  let cursor;
  let done = false;
  // Each page follows the cursor the page before it returned.
  const run = async (/** @type {number} */ page) => {
    if (done) return { statusCode: 0, body: "(after the last page)" };
    const res = await h[route](
      event({ query: { ...query, ...(cursor && { cursor }) } }),
    );
    cursor = JSON.parse(res.body).nextCursor ?? undefined;
    done = !cursor;
    // Otherwise a longer list would pass with its last pages never read.
    if (page === 8 && !done) throw new Error(`${route} has more than 8 pages`);
    return res;
  };
  for (let page = 1; page <= 8; page++)
    cases.push([`page ${page}`, () => run(page)]);
  return cases;
}

/**
 * Every value of each filter, one case each.
 * @param {Record<string, string[]>} values
 * @param {(query: Record<string, string>) => Promise<any>} call
 * @param {Record<string, string>} base
 * @returns {Case[]}
 */
const eachFilter = (values, call, base) =>
  Object.entries(values).flatMap(([name, list]) =>
    list.map(
      (value) =>
        /** @type {Case} */ ([
          `${name}=${value}`,
          () => call({ ...base, [name]: value }),
        ]),
    ),
  );

/**
 * Every sort key both ways.
 * @param {Record<string, string>} sorts
 * @param {(query: Record<string, string>) => Promise<any>} call
 * @param {Record<string, string>} base
 * @returns {Case[]}
 */
const eachSort = (sorts, call, base) =>
  Object.keys(sorts).flatMap((sort) =>
    ["asc", "desc"].map(
      (dir) =>
        /** @type {Case} */ ([
          `sort=${sort} dir=${dir}`,
          () => call({ ...base, sort, dir }),
        ]),
    ),
  );

const PERIODS = {
  "default month": {},
  october: OCTOBER,
  november: { period: "month", month: "2026-11" },
  "august, before coverage": { period: "month", month: "2026-08" },
  "quarter 4": { period: "quarter", year: "2026", quarter: "4" },
  "year 2026": { period: "year", year: "2026" },
  "financial year 2026": FY,
  custom: { period: "custom", from: "2026-10-05", to: "2026-10-21" },
  "custom from today, no prior": {
    period: "custom",
    from: "2026-11-04",
    to: "2026-11-05",
  },
};

/**
 * @param {(query: Record<string, string>) => Promise<any>} call
 * @returns {Case[]}
 */
const eachPeriod = (call) =>
  Object.entries(PERIODS).map(([name, query]) => [name, () => call(query)]);

/** @param {Record<string, string>} query */
const overviewCall = (query) => h.getOverview(event({ query }));
/** @param {Record<string, string>} query */
const issuesCall = (query) => h.listIssues(event({ query }));
/** @param {Record<string, string>} query */
const checksCall = (query) => h.listChecks(event({ query }));
/** @param {unknown} body */
const trendsCall = (body) => h.postTrends(event({ body }));

/**
 * Runs a job through the handlers, so the CSV and report bytes are the job's own.
 * @param {"postExport" | "postReport"} route
 * @param {Record<string, unknown>} body
 * @param {string} key
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
async function jobCase(route, body, key) {
  const created = await h[route](event({ body, key }));
  if (created.statusCode !== 202) return created;
  const ref = /** @type {{ ownerKey: string, jobId: string }} */ (
    started.at(-1)
  );
  await h.runJob(ref);
  const job = await h.getJob(event({ path: { jobId: ref.jobId } }));
  const result = jobStore.results.get(`${ref.ownerKey}/${ref.jobId}`) ?? "";
  return {
    statusCode: job.statusCode,
    body: `${created.body}\n${job.body}\n${result}`,
  };
}

describe("job replies", () => {
  it("answers 404 for a job that was never made", async () => {
    const res = await h.getJob(event({ path: { jobId: "f".repeat(32) } }));
    expect([res.statusCode, JSON.parse(res.body).error]).toEqual([
      404,
      "job_not_found",
    ]);
  });
});

describe("golden replies", () => {
  it("Overview, every sort both ways", () =>
    expectGolden("overview-sorts", eachSort(SORTS.sites, overviewCall, FY)));

  it("Overview, every filter value", () =>
    expectGolden("overview-filters", [
      ...eachFilter(
        {
          show: ["all", "top", "unknown"],
          responseState: [
            "awaiting",
            "overdue",
            "onTime",
            "late",
            "unknown",
            "notTimed",
            "overdue,late",
          ],
          publicContact: ["available", "missing", "unknown"],
          siteContact: ["available", "missing", "unknown"],
        },
        overviewCall,
        FY,
      ),
      overviewCase("search 'site 9'", { ...FY, q: "site 9" }),
      overviewCase("search by ID", { ...FY, q: "S7" }),
      overviewCase("siteIds", { ...FY, siteIds: "s5,s1,s4" }),
      ...SITE_DIMENSIONS.map(
        (dim) =>
          /** @type {Case} */ ([
            `${dim} filter`,
            () =>
              overviewCall({
                ...FY,
                [dim]: {
                  status: "inactive",
                  siteType: "drop_in",
                  providerId: "v1",
                  programId: "p3",
                  department: "Other Department",
                  managerId: "pm1",
                }[dim],
              }),
          ]),
      ),
    ]));

  it("Overview, every period kind", () =>
    expectGolden("overview-periods", eachPeriod(overviewCall)));

  it("Site pages", () =>
    expectGolden("sites", [
      ...["s1", "s2", "s3", "s4", "s5", "s6", "s7"].flatMap((siteId) =>
        [
          ["october", OCTOBER],
          ["financial year", FY],
        ].map(
          ([name, query]) =>
            /** @type {Case} */ ([
              `${siteId} ${name}`,
              () =>
                h.getSite(
                  event({
                    path: { siteId },
                    query: /** @type {any} */ (query),
                  }),
                ),
            ]),
        ),
      ),
      ...eachPeriod((query) =>
        h.getSite(event({ path: { siteId: "s5" }, query })),
      ),
      ["unknown Site", () => h.getSite(event({ path: { siteId: "nope" } }))],
    ]));

  it("Issues, every sort both ways", () =>
    expectGolden("issues-sorts", eachSort(SORTS.issues, issuesCall, FY)));

  it("Issues, every filter value", () =>
    expectGolden("issues-filters", [
      ...eachFilter(
        {
          severityBand: [
            "minor",
            "moderate",
            "severe",
            "unknown",
            "severe,unknown",
          ],
          responseState: [
            "awaiting",
            "overdue",
            "onTime",
            "late",
            "unknown",
            "notTimed",
            "overdue,late",
          ],
          source: ["perimeter", "single-problem", "unknown"],
          issueStatus: ["open", "resolved"],
          concern: ["slowResponse", "repeatedSevere"],
          category: ["Debris", "Café débris", "Unsecured gate", "None such"],
        },
        issuesCall,
        FY,
      ),
      ["search", () => issuesCall({ ...FY, q: "site 9" })],
      ["siteIds", () => issuesCall({ ...FY, siteIds: "s5,s6" })],
      ["provider", () => issuesCall({ ...FY, providerId: "v1" })],
      [
        "filters together",
        () =>
          issuesCall({
            ...FY,
            severityBand: "severe",
            issueStatus: "resolved",
            sort: "siteName",
          }),
      ],
    ]));

  it("Issues, every period kind", () =>
    expectGolden("issues-periods", eachPeriod(issuesCall)));

  it("Issues, paged to the last page", () =>
    expectGolden("issues-paging", [
      ...pages("listIssues", { ...FY, limit: "2" }),
      ...pages("listIssues", { ...FY, limit: "3", sort: "siteName" }).map(
        ([name, run]) => /** @type {Case} */ ([`by name, ${name}`, run]),
      ),
      [
        "cursor from another query",
        async () => {
          const first = await issuesCall({ ...FY, limit: "2" });
          return issuesCall({
            ...FY,
            limit: "2",
            sort: "severity",
            cursor: JSON.parse(first.body).nextCursor,
          });
        },
      ],
      ["garbled cursor", () => issuesCall({ ...FY, cursor: "%%%" })],
    ]));

  it("Checks, every sort both ways", () =>
    expectGolden("checks-sorts", eachSort(SORTS.checks, checksCall, FY)));

  it("Checks, every filter value and period", () =>
    expectGolden("checks-filters", [
      ...eachFilter(
        {
          state: ["completed", "unfinished"],
          source: ["perimeter", "single-problem"],
        },
        checksCall,
        FY,
      ),
      ["siteIds", () => checksCall({ ...FY, siteIds: "s1,s5" })],
      ["search", () => checksCall({ ...FY, q: "site 1" })],
      ...eachPeriod(checksCall),
    ]));

  it("Checks, paged to the last page", () =>
    expectGolden("checks-paging", [
      ...pages("listChecks", { ...FY, limit: "3" }),
      ...pages("listChecks", { ...FY, limit: "4", sort: "siteName" }).map(
        ([name, run]) => /** @type {Case} */ ([`by name, ${name}`, run]),
      ),
    ]));

  it("Issue and Check details", () =>
    expectGolden("details", [
      ...[
        ["t1", undefined],
        ["t1", "s1"],
        ["t1", "s5"],
        ["t3", undefined],
        ["t7", undefined],
        ["t8", undefined],
        ["t9", undefined],
        ["t1", "s2"],
        ["nope", undefined],
      ].map(
        ([issueId, siteId]) =>
          /** @type {Case} */ ([
            `issue ${issueId} site ${siteId}`,
            () =>
              h.getIssue(
                event({
                  path: { issueId: String(issueId) },
                  query: siteId ? { siteId } : undefined,
                }),
              ),
          ]),
      ),
      ...[
        ["c1", undefined],
        ["c1", "s1"],
        ["c1", "s5"],
        ["c5", undefined],
        ["c9", undefined],
        ["c10", undefined],
        ["c1", "s3"],
        ["nope", undefined],
      ].map(
        ([checkId, siteId]) =>
          /** @type {Case} */ ([
            `check ${checkId} site ${siteId}`,
            () =>
              h.getCheck(
                event({
                  path: { checkId: String(checkId) },
                  query: siteId ? { siteId } : undefined,
                }),
              ),
          ]),
      ),
    ]));

  it("Scope options", () =>
    expectGolden("scope-options", [
      ["default", () => h.getScopeOptions(event())],
      [
        "with Sites",
        () => h.getScopeOptions(event({ query: { include: "sites" } })),
      ],
    ]));

  it("Trends", () =>
    expectGolden("trends", [
      ["citywide default", () => trendsCall({})],
      ...Object.entries(PERIODS).map(
        ([name, query]) =>
          /** @type {Case} */ ([name, () => trendsCall(query)]),
      ),
      ...SITE_DIMENSIONS.map(
        (breakdown) =>
          /** @type {Case} */ ([
            `breakdown ${breakdown}`,
            () => trendsCall({ ...FY, breakdown }),
          ]),
      ),
      [
        "picked Sites",
        () => trendsCall({ ...FY, scope: { siteIds: ["s5", "s1"] } }),
      ],
      [
        "groups",
        () =>
          trendsCall({
            ...OCTOBER,
            scope: { groups: { siteType: ["shelter"], providerId: ["v1"] } },
          }),
      ],
      [
        "groups and picked Sites",
        () =>
          trendsCall({
            ...FY,
            scope: { siteIds: ["s7"], groups: { siteType: ["drop_in"] } },
            breakdown: "providerId",
          }),
      ],
      [
        "unknown Site",
        () => trendsCall({ ...FY, scope: { siteIds: ["nope"] } }),
      ],
    ]));

  it("Exports, one per dataset and with filters", () =>
    expectGolden("exports", [
      [
        "issues",
        () => jobCase("postExport", { dataset: "issues", ...FY }, "golden-e1"),
      ],
      [
        "checks",
        () => jobCase("postExport", { dataset: "checks", ...FY }, "golden-e2"),
      ],
      [
        "sites",
        () => jobCase("postExport", { dataset: "sites", ...FY }, "golden-e3"),
      ],
      [
        "issues by name, severe",
        () =>
          jobCase(
            "postExport",
            {
              dataset: "issues",
              ...FY,
              sort: "siteName",
              severityBand: "severe",
            },
            "golden-e4",
          ),
      ],
      [
        "checks by name, one provider",
        () =>
          jobCase(
            "postExport",
            {
              dataset: "checks",
              ...OCTOBER,
              sort: "siteName",
              providerId: "v3",
            },
            "golden-e5",
          ),
      ],
      [
        "sites with concerns, by Issues",
        () =>
          jobCase(
            "postExport",
            { dataset: "sites", ...FY, show: "top", sort: "issuesPer30Days" },
            "golden-e6",
          ),
      ],
    ]));

  it("Reports", () =>
    expectGolden("reports", [
      [
        "every Site, financial year",
        () =>
          jobCase(
            "postReport",
            {
              siteIds: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
              ...FY,
            },
            "golden-r1",
          ),
      ],
      [
        "two Sites, October",
        () =>
          jobCase(
            "postReport",
            { siteIds: ["s6", "s5"], ...OCTOBER },
            "golden-r2",
          ),
      ],
      [
        "unknown Site",
        () => jobCase("postReport", { siteIds: ["nope"] }, "golden-r3"),
      ],
    ]));
});
