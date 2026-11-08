import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

// Reporting reads the projection only; any DynamoDB call is a bug.
const { ddbSend, logServerError } = vi.hoisted(() => ({
  ddbSend: vi.fn(async () => {
    throw new Error("Insights must not read the app table");
  }),
  logServerError: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../lib/log-server-error.js", () => ({ logServerError }));

const {
  MAX_REPORT_BODY_BYTES,
  MAX_TRENDS_BODY_BYTES,
  createReportingHandlers,
} = await import("./admin-reporting.js");
const { createSnapshotStore } = await import("../reporting/api/snapshot.js");
const { memoryJobStore } = await import("../reporting/api/jobs.js");
const { LIMITS, SITE_DIMENSIONS, requestError } = await import(
  "../reporting/api/requests.js"
);

const { syntheticProjection, tablesSource, writeSyntheticProjection } =
  await import("../reporting/api/test-projection.js");

const NOW = Date.parse("2026-11-04T20:00:00.000Z");

/**
 * @param {{ groups?: string, sub?: string, query?: Record<string, string>, body?: unknown, path?: Record<string, string>, headers?: Record<string, string> }} [opts]
 * @returns {any}
 */
function event({
  groups = "compliance-manager",
  sub = "manager-1",
  query,
  body,
  path,
  headers = {},
} = {}) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { "cognito:groups": groups, sub } } },
    },
    queryStringParameters: query,
    pathParameters: path,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** @param {any} res */
const json = (res) => JSON.parse(res.body);

// The widest a client can write a character: a \u20ac escape is 6 bytes.
/** @param {unknown} body */
const escapedJson = (body) => JSON.stringify(body).replaceAll("€", "\\u20ac");

/** @param {{ source?: any, maxExportRows?: number, jobStore?: any }} [opts] */
function setup(opts = {}) {
  const projection = syntheticProjection();
  const source = opts.source ?? tablesSource(projection);
  /** @type {{ ownerKey: string, jobId: string }[]} */
  const started = [];
  const jobStore =
    opts.jobStore === undefined ? memoryJobStore() : opts.jobStore;
  const h = createReportingHandlers({
    snapshots: createSnapshotStore({ source }),
    jobStore,
    starter: async (ref) => {
      started.push(ref);
    },
    now: () => NOW,
    maxExportRows: opts.maxExportRows,
  });
  return { h, started, jobStore, projection };
}

// A block body: a returned mock would run as the hook's teardown.
beforeEach(() => {
  ddbSend.mockClear();
  logServerError.mockClear();
});

describe("who may read Insights", () => {
  it("lets a Compliance manager read citywide Overview", async () => {
    const { h } = setup();
    const res = await h.getOverview(event());
    expect(res.statusCode).toBe(200);
    expect(json(res).siteCount).toBe(3);
  });

  it("lets a supervisor read it too", async () => {
    const { h } = setup();
    const res = await h.getOverview(event({ groups: "compliance-supervisor" }));
    expect(res.statusCode).toBe(200);
  });

  it("refuses a caller with no admin group, such as a device user", async () => {
    const { h } = setup();
    const res = await h.getOverview(event({ groups: "" }));
    expect([res.statusCode, json(res).error]).toEqual([403, "forbidden"]);
  });

  it("refuses every endpoint, jobs included, without the Insights capability", async () => {
    const { h } = setup();
    const calls = [
      h.getSite(event({ groups: "", path: { siteId: "s1" } })),
      h.listIssues(event({ groups: "" })),
      h.listChecks(event({ groups: "" })),
      h.getScopeOptions(event({ groups: "" })),
      h.postTrends(event({ groups: "", body: {} })),
      h.postExport(event({ groups: "", body: { dataset: "issues" } })),
      h.postReport(event({ groups: "", body: { siteIds: ["s1"] } })),
      h.getJob(event({ groups: "", path: { jobId: "j" } })),
      h.cancelJob(event({ groups: "", path: { jobId: "j" } })),
      h.getIssue(event({ groups: "", path: { issueId: "t1" } })),
      h.getCheck(event({ groups: "", path: { checkId: "c1" } })),
    ];
    expect((await Promise.all(calls)).map((r) => r.statusCode)).toEqual(
      Array(calls.length).fill(403),
    );
  });

  it("refuses a token with the group but no identity, so jobs can't be shared", async () => {
    const { h } = setup();
    const res = await h.postExport(
      event({
        sub: "",
        headers: { "idempotency-key": "click-0001" },
        body: { dataset: "issues" },
      }),
    );
    expect(res.statusCode).toBe(403);
  });

  it("never reads the app table, jobs included", async () => {
    const { h, started } = setup();
    await h.getOverview(event());
    await h.listIssues(event({ query: { period: "month", month: "2026-10" } }));
    const created = json(
      await h.postReport(
        event({
          headers: { "idempotency-key": "click-0001" },
          body: { siteIds: ["s1"] },
        }),
      ),
    );
    await h.runJob(started[0]);
    await h.getJob(event({ path: { jobId: created.job.jobId } }));
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("reads", () => {
  it("answers a bad period with 400 and its code", async () => {
    const { h } = setup();
    const res = await h.getOverview(event({ query: { period: "week" } }));
    expect([res.statusCode, json(res).error]).toEqual([400, "invalid_period"]);
  });

  it("answers 503 with no snapshot, so the page shows unavailable, not zero, and logs nothing per request", async () => {
    const { h } = setup({
      source: { latest: async () => null, load: async () => ({}) },
    });
    const res = await h.getOverview(event());
    expect([res.statusCode, json(res).error]).toEqual([
      503,
      "snapshot_unavailable",
    ]);
    // Every page load before the first build would otherwise trip the error alarm.
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("answers 503 without a log line per request when a snapshot file has expired", async () => {
    const { h } = setup({
      source: {
        latest: async () => ({ prefix: "p1", snapshotId: "snap1" }),
        load: async () => {
          throw Object.assign(requestError("snapshot_unavailable", 503), {
            expiredKey: "p1/issues.parquet",
          });
        },
      },
    });
    const res = await h.getOverview(event());
    expect([res.statusCode, json(res).error]).toEqual([
      503,
      "snapshot_unavailable",
    ]);
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("logs a snapshot that is unavailable for any reason but a missing latest.json", async () => {
    const { h } = setup({
      source: {
        latest: async () => ({ prefix: "p1", snapshotId: "snap1" }),
        load: async () => {
          throw requestError("snapshot_unavailable", 503);
        },
      },
    });
    const res = await h.getOverview(event());
    expect([res.statusCode, json(res).error]).toEqual([
      503,
      "snapshot_unavailable",
    ]);
    expect(logServerError).toHaveBeenCalledOnce();
  });

  it("logs a 503 that is ours to fix, such as a snapshot of another contract", async () => {
    const projection = syntheticProjection();
    const { h } = setup({
      source: tablesSource({
        ...projection,
        manifest: { ...projection.manifest, contractVersion: "old" },
      }),
    });
    const res = await h.getOverview(event());
    expect([res.statusCode, json(res).error]).toEqual([
      503,
      "snapshot_contract_mismatch",
    ]);
    expect(logServerError).toHaveBeenCalledOnce();
  });

  it("answers 400 without logging, since the caller's request was wrong", async () => {
    const { h } = setup();
    await h.getOverview(event({ query: { period: "week" } }));
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("answers 502 without detail when something unexpected breaks", async () => {
    const { h } = setup({
      source: {
        latest: async () => {
          throw new Error("secret bucket name");
        },
        load: async () => ({}),
      },
    });
    const res = await h.getOverview(event());
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("secret");
    expect(logServerError).toHaveBeenCalledOnce();
  });

  it("returns one Site's detail by path", async () => {
    const { h } = setup();
    const res = await h.getSite(
      event({
        path: { siteId: "s2" },
        query: { period: "month", month: "2026-10" },
      }),
    );
    expect(json(res).totals.response.late).toBe(1);
  });

  it("returns an Issue and a Check by ID", async () => {
    const { h } = setup();
    const issue = await h.getIssue(event({ path: { issueId: "t5" } }));
    const check = await h.getCheck(event({ path: { checkId: "c7" } }));
    expect([json(issue).issue.siteId, json(check).issues[0].issueId]).toEqual([
      "s2",
      "t5",
    ]);
  });

  it("filters Issues by Site status and by Issue status separately", async () => {
    const { h } = setup();
    const october = { period: "month", month: "2026-10" };
    const active = await h.listIssues(
      event({ query: { ...october, status: "active" } }),
    );
    // Checks, since s3, the only inactive Site, has one but no Issues.
    const inactive = await h.listChecks(
      event({ query: { ...october, status: "inactive" } }),
    );
    const resolved = await h.listIssues(
      event({ query: { ...october, issueStatus: "resolved" } }),
    );
    expect(json(active).total).toBe(4);
    expect(
      json(inactive).checks.map((/** @type {any} */ c) => c.checkId),
    ).toEqual(["c8"]);
    expect(
      json(resolved).issues.map((/** @type {any} */ i) => i.issueId),
    ).toEqual(["t3"]);
  });

  it("returns Trends for a picked scope from a JSON body", async () => {
    const { h } = setup();
    const res = await h.postTrends(
      event({
        body: {
          period: "month",
          month: "2026-10",
          scope: { siteIds: ["s2"] },
          breakdown: "siteType",
        },
      }),
    );
    expect(json(res).scope.siteIds).toEqual(["s2"]);
  });

  it("refuses a Trends scope over the picked-Site limit", async () => {
    const { h } = setup();
    const ids = Array.from(
      { length: LIMITS.maxTrendSites + 1 },
      (_, i) => `s${i}`,
    );
    const res = await h.postTrends(
      event({ body: { scope: { siteIds: ids } } }),
    );
    expect(json(res).error).toBe("too_many_sites");
  });

  it("refuses a Trends scope naming a Site the snapshot doesn't have", async () => {
    const { h } = setup();
    const res = await h.postTrends(
      event({ body: { scope: { siteIds: ["s1", "s-typo"] } } }),
    );
    expect(json(res).error).toBe("unknown_site");
  });

  it("refuses a Trends group the API doesn't offer", async () => {
    const { h } = setup();
    const res = await h.postTrends(
      event({ body: { scope: { groups: { email: ["x"] } } } }),
    );
    expect(json(res).error).toBe("invalid_group");
  });

  it("refuses a Trends body over its byte limit before parsing it, since the WAF lets it through", async () => {
    const { h } = setup();
    const res = await h.postTrends({
      ...event(),
      body: `{${" ".repeat(MAX_TRENDS_BODY_BYTES)}`,
    });
    expect([res.statusCode, json(res).error]).toEqual([
      413,
      "request_too_large",
    ]);
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("measures a base64 Trends body once decoded, as the assessment route does", async () => {
    const { h } = setup();
    const res = await h.postTrends({
      ...event(),
      isBase64Encoded: true,
      body: Buffer.from("{}".padEnd(MAX_TRENDS_BODY_BYTES + 1, " ")).toString(
        "base64",
      ),
    });
    expect(res.statusCode).toBe(413);
  });

  it.each([
    [MAX_TRENDS_BODY_BYTES - 1, 200],
    [MAX_TRENDS_BODY_BYTES, 200],
    [MAX_TRENDS_BODY_BYTES + 1, 413],
  ])(
    "counts a base64 body of %i bytes exactly, whatever its padding",
    async (bytes, status) => {
      const { h } = setup();
      const res = await h.postTrends({
        ...event(),
        isBase64Encoded: true,
        body: Buffer.from(
          '{"period":"month","month":"2026-10"}'.padEnd(bytes, " "),
        ).toString("base64"),
      });
      expect(res.statusCode).toBe(status);
    },
  );

  it("takes the largest Trends body LIMITS allow, in six-byte JSON escapes", async () => {
    const { h } = setup();
    const value = (/** @type {number} */ i) =>
      `${i}`.padEnd(LIMITS.maxFilterLength, "€");
    const values = Array.from({ length: LIMITS.maxGroupValues }, (_, i) =>
      value(i),
    );
    const body = {
      period: "custom",
      from: "2026-10-01",
      to: "2026-10-31",
      breakdown: "providerId",
      scope: {
        siteIds: Array.from({ length: LIMITS.maxTrendSites }, (_, i) =>
          value(i),
        ),
        groups: Object.fromEntries(SITE_DIMENSIONS.map((dim) => [dim, values])),
      },
    };
    const res = await h.postTrends({
      ...event(),
      body: escapedJson(body),
    });
    // Past the byte limit and JSON.parse, to the check that the Sites exist.
    expect(json(res).error).toBe("unknown_site");
  });

  it("refuses a body that isn't JSON", async () => {
    const { h } = setup();
    const res = await h.postTrends({ ...event(), body: "{" });
    expect(json(res).error).toBe("invalid_json");
  });

  it("narrows Trends to a group of Sites", async () => {
    const { h } = setup();
    const res = await h.postTrends(
      event({ body: { scope: { groups: { siteType: ["drop_in"] } } } }),
    );
    expect(json(res).scope.siteIds).toEqual(["s2"]);
  });

  it.each([
    ["a scope that's a list", { scope: [] }, "invalid_scope"],
    ["a scope that's text", { scope: "s1" }, "invalid_scope"],
    [
      "a group that isn't a list",
      { scope: { groups: { siteType: "shelter" } } },
      "invalid_group",
    ],
    [
      "too many group values",
      {
        scope: {
          groups: { siteType: Array(LIMITS.maxGroupValues + 1).fill("x") },
        },
      },
      "invalid_group",
    ],
    [
      "a group value that isn't text",
      { scope: { groups: { siteType: [1] } } },
      "invalid_group",
    ],
    [
      "a group value that's too long",
      {
        scope: {
          groups: { siteType: ["x".repeat(LIMITS.maxFilterLength + 1)] },
        },
      },
      "invalid_group",
    ],
    [
      "a breakdown the API doesn't offer",
      { breakdown: "email" },
      "invalid_breakdown",
    ],
  ])("refuses a Trends request with %s", async (_, body, code) => {
    const { h } = setup();
    const res = await h.postTrends(event({ body }));
    expect([res.statusCode, json(res).error]).toEqual([400, code]);
  });
});

/**
 * reportingHandlers over a fresh projection folder, as the local API runs it.
 * @param {NodeJS.ProcessEnv} env
 */
async function handlersOverFolder(env) {
  const dir = mkdtempSync(join(tmpdir(), "insights-wiring-"));
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await writeSyntheticProjection(conn, dir);
  conn.closeSync();
  vi.resetModules();
  const fresh = await import("./admin-reporting.js");
  const h = fresh.reportingHandlers({ INSIGHTS_PROJECTION_DIR: dir, ...env });
  const manifestPath = join(dir, "manifest.json");
  return {
    snapshotId: async () => json(await h.getOverview(event())).meta.snapshotId,
    // `npm run insights:data` rebuilds in place: same folder, new snapshot ID.
    rebuild: () =>
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(manifestPath, "utf8")),
          snapshotId: "snap2",
        }),
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("export and report jobs", () => {
  const key = { "idempotency-key": "click-0001" };

  it("queues a CSV export and returns 202 with the job", async () => {
    const { h, started } = setup();
    const res = await h.postExport(
      event({
        headers: key,
        body: { dataset: "issues", period: "month", month: "2026-10" },
      }),
    );
    expect([res.statusCode, json(res).job.state]).toEqual([202, "queued"]);
    expect(started).toHaveLength(1);
  });

  it("makes one job from a double click with the same key", async () => {
    const { h, started } = setup();
    const body = { dataset: "issues", period: "month", month: "2026-10" };
    const first = await h.postExport(event({ headers: key, body }));
    const second = await h.postExport(event({ headers: key, body }));
    expect([first.statusCode, second.statusCode]).toEqual([202, 200]);
    expect(json(second).job.jobId).toBe(json(first).job.jobId);
    expect(started).toHaveLength(1);
  });

  it("requires an Idempotency-Key, so a double click can't make two jobs", async () => {
    const { h } = setup();
    const res = await h.postExport(event({ body: { dataset: "issues" } }));
    expect(json(res).error).toBe("idempotency_key_required");
  });

  it("refuses an export larger than the row limit before queueing it", async () => {
    // October has 5 Checks; a limit of 4 is one short.
    const { h, started } = setup({ maxExportRows: 4 });
    const res = await h.postExport(
      event({
        headers: key,
        body: { dataset: "checks", period: "month", month: "2026-10" },
      }),
    );
    expect([res.statusCode, json(res).error]).toEqual([
      413,
      "export_too_large",
    ]);
    expect(started).toEqual([]);
  });

  it("accepts an export of exactly the row limit", async () => {
    const { h } = setup({ maxExportRows: 5 });
    const res = await h.postExport(
      event({
        headers: key,
        body: { dataset: "checks", period: "month", month: "2026-10" },
      }),
    );
    expect(res.statusCode).toBe(202);
  });

  it("exports only the Issues the list shows, Issue status included", async () => {
    const { h, started, jobStore } = setup();
    const created = json(
      await h.postExport(
        event({
          headers: key,
          body: {
            dataset: "issues",
            period: "month",
            month: "2026-10",
            issueStatus: "resolved",
          },
        }),
      ),
    );
    await h.runJob(started[0]);
    const done = json(
      await h.getJob(event({ path: { jobId: created.job.jobId } })),
    ).job;
    const csv = [...jobStore.results.values()][0];
    expect(csv.split("\r\n")[1]).toMatch(/^t3,/);
    expect(done.result).toMatchObject({
      rows: 1,
      // The period's last day, not the exclusive day after it.
      filename: expect.stringMatching(
        /^insights-issues-2026-10-01-to-2026-10-31-/,
      ),
    });
  });

  it("exports only the Issues behind a concern flag, as its list shows them", async () => {
    const { h, started } = setup();
    const created = json(
      await h.postExport(
        event({
          headers: key,
          body: {
            dataset: "issues",
            period: "month",
            month: "2026-10",
            concern: "repeatedSevere",
          },
        }),
      ),
    );
    await h.runJob(started[0]);
    const done = json(
      await h.getJob(event({ path: { jobId: created.job.jobId } })),
    ).job;
    // t1 and t3 are October's Severe Issues.
    expect(done.result.rows).toBe(2);
  });

  it("builds the CSV the requester downloads, with formulas defused", async () => {
    const { h, started, jobStore, projection } = setup();
    projection.tables.sites[0].name = "=HYPERLINK(1)";
    const created = json(
      await h.postExport(
        event({
          headers: key,
          body: { dataset: "sites", period: "month", month: "2026-10" },
        }),
      ),
    );
    await h.runJob(started[0]);
    const status = json(
      await h.getJob(event({ path: { jobId: created.job.jobId } })),
    );
    expect(status.job).toMatchObject({
      state: "succeeded",
      result: { rows: 3 },
    });
    const csv = [...jobStore.results.values()][0];
    expect(csv.split("\r\n")[1]).toMatch(/^s1,'=HYPERLINK\(1\),/);
  });

  it("hides one requester's job from another", async () => {
    const { h } = setup();
    const created = json(
      await h.postExport(event({ headers: key, body: { dataset: "issues" } })),
    );
    const res = await h.getJob(
      event({ sub: "manager-2", path: { jobId: created.job.jobId } }),
    );
    expect(res.statusCode).toBe(404);
  });

  it("limits a report to between 1 Site and more than the city has", async () => {
    const { h } = setup();
    const none = await h.postReport(
      event({ headers: key, body: { siteIds: [] } }),
    );
    const tooMany = await h.postReport(
      event({
        headers: key,
        body: {
          siteIds: Array.from(
            { length: LIMITS.maxReportSites + 1 },
            (_, i) => `s${i}`,
          ),
        },
      }),
    );
    expect([json(none).error, json(tooMany).error]).toEqual([
      "invalid_site_ids",
      "too_many_sites",
    ]);
  });

  it("refuses a report body over its byte limit before parsing it, since the WAF lets it through", async () => {
    const { h } = setup();
    const res = await h.postReport({
      ...event({ headers: key }),
      body: `{${" ".repeat(MAX_REPORT_BODY_BYTES)}`,
    });
    expect([res.statusCode, json(res).error]).toEqual([
      413,
      "request_too_large",
    ]);
  });

  it("takes the largest report body LIMITS allow, in six-byte JSON escapes", async () => {
    const { h } = setup();
    const siteIds = Array.from({ length: LIMITS.maxReportSites }, (_, i) =>
      `${i}`.padEnd(LIMITS.maxFilterLength, "€"),
    );
    const res = await h.postReport({
      ...event({ headers: key }),
      body: escapedJson({ siteIds, period: "quarter", year: 2026, quarter: 4 }),
    });
    // Past the byte limit and JSON.parse, to the check that the Sites exist.
    expect(json(res).error).toBe("unknown_site");
  });

  it("refuses a report for a Site the snapshot doesn't have", async () => {
    const { h } = setup();
    const res = await h.postReport(
      event({ headers: key, body: { siteIds: ["s1", "s9"] } }),
    );
    expect(json(res).error).toBe("unknown_site");
  });

  it("builds a report for a quarter, as the dialog asked", async () => {
    const { h, started, jobStore } = setup();
    const res = await h.postReport(
      event({
        headers: key,
        body: {
          siteIds: ["s1", "s2"],
          period: "quarter",
          year: 2026,
          quarter: 4,
        },
      }),
    );
    await h.runJob(started[0]);
    const report = JSON.parse([...jobStore.results.values()][0]);
    expect(res.statusCode).toBe(202);
    expect(report.meta.interval).toMatchObject({
      kind: "quarter",
      startDay: "2026-10-01",
      endDay: "2027-01-01",
    });
    // s1's November Issue falls inside the quarter, s2's September one outside.
    expect(
      report.sites.map(
        (/** @type {any} */ s) => s.totals.activity.issuesCreated,
      ),
    ).toEqual([4, 1]);
  });

  it("lists only Site IDs and names in scope options, and only when asked", async () => {
    const { h } = setup();
    const plain = json(await h.getScopeOptions(event()));
    const named = json(
      await h.getScopeOptions(event({ query: { include: "sites" } })),
    );
    expect([plain.sites, Object.keys(named.sites[0]).sort()]).toEqual([
      undefined,
      ["name", "siteId"],
    ]);
  });

  it("builds a report dataset with the same counts as Site detail", async () => {
    const { h, started, jobStore } = setup();
    await h.postReport(
      event({
        headers: key,
        body: { siteIds: ["s1"], period: "month", month: "2026-10" },
      }),
    );
    await h.runJob(started[0]);
    const report = JSON.parse([...jobStore.results.values()][0]);
    const detail = json(
      await h.getSite(
        event({
          path: { siteId: "s1" },
          query: { period: "month", month: "2026-10" },
        }),
      ),
    );
    expect(report.sites[0].totals).toEqual(detail.totals);
  });

  it("answers 503 for jobs, and still serves reads, with no job storage", async () => {
    const { h } = setup({ jobStore: null });
    const exp = await h.postExport(
      event({ headers: key, body: { dataset: "issues" } }),
    );
    expect([exp.statusCode, json(exp).error]).toEqual([
      503,
      "jobs_unavailable",
    ]);
    expect((await h.getOverview(event())).statusCode).toBe(200);
  });

  it.each([
    [
      "off in a Lambda with no queue, since it stops after replying",
      {
        AWS_LAMBDA_FUNCTION_NAME: "analytics-query",
        INSIGHTS_JOBS_BUCKET: "j",
      },
      false,
    ],
    ["off with no jobs bucket, since the lake is read-only", {}, false],
    [
      "on in a Lambda with a queue and a bucket",
      {
        AWS_LAMBDA_FUNCTION_NAME: "analytics-query",
        INSIGHTS_JOBS_BUCKET: "j",
        INSIGHTS_JOBS_QUEUE_URL: "https://sqs.example.org/q",
      },
      true,
    ],
    ["on locally with a bucket", { INSIGHTS_JOBS_BUCKET: "j" }, true],
  ])("turns jobs %s", async (_, env, on) => {
    vi.resetModules();
    const fresh = await import("./admin-reporting.js");
    const h = fresh.reportingHandlers({ LAKE_BUCKET: "lake", ...env });
    // No key: with jobs on it stops at the key check, before any storage call.
    const res = await h.postExport(event({ body: { dataset: "issues" } }));
    expect(json(res).error).toBe(
      on ? "idempotency_key_required" : "jobs_unavailable",
    );
  });

  it.each([
    ["queues a job when a queue is set", "https://sqs.example.org/q", 1],
    ["runs a job in-process with no queue", undefined, 0],
  ])("%s", async (_, queueUrl, messages) => {
    vi.resetModules();
    const { SQSClient } = await import("@aws-sdk/client-sqs");
    const { S3Client } = await import("@aws-sdk/client-s3");
    const sent = vi.spyOn(SQSClient.prototype, "send");
    sent.mockImplementation(async () => ({}));
    const objects = new Map();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      const { Key, Body } = /** @type {any} */ (command).input;
      if (Body !== undefined) return objects.set(Key, Body);
      if (objects.has(Key))
        return { Body: { transformToString: async () => objects.get(Key) } };
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    });
    const dir = mkdtempSync(join(tmpdir(), "insights-handler-"));
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      await writeSyntheticProjection(conn, dir);
      const fresh = await import("./admin-reporting.js");
      const h = fresh.reportingHandlers({
        INSIGHTS_PROJECTION_DIR: dir,
        INSIGHTS_JOBS_BUCKET: "j",
        INSIGHTS_JOBS_QUEUE_URL: queueUrl,
      });
      const res = await h.postExport(
        event({ headers: key, body: { dataset: "issues" } }),
      );
      expect(res.statusCode).toBe(202);
      expect(sent).toHaveBeenCalledTimes(messages);
      if (messages)
        expect(
          JSON.parse(
            /** @type {any} */ (sent.mock.calls[0][0]).input.MessageBody,
          ).insightsJob.jobId,
        ).toBe(json(res).job.jobId);
      // The job runs after the reply, so it must finish before the S3 mock and folder go.
      else
        await vi.waitFor(() => {
          const record = [...objects].find(([k]) =>
            k.endsWith(`${json(res).job.jobId}.json`),
          )?.[1];
          expect(JSON.parse(String(record)).state).toBe("succeeded");
        });
    } finally {
      vi.restoreAllMocks();
      conn.closeSync();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "shows a rebuilt projection on the next request with INSIGHTS_REFRESH_MS=0",
      "0",
      "snap2",
    ],
    [
      "keeps serving the loaded projection between checks without it",
      undefined,
      "snap1",
    ],
    ["ignores an INSIGHTS_REFRESH_MS that isn't a number", "soon", "snap1"],
  ])("%s", async (_, setting, expected) => {
    const folder = await handlersOverFolder({ INSIGHTS_REFRESH_MS: setting });
    try {
      expect(await folder.snapshotId()).toBe("snap1");
      folder.rebuild();
      expect(await folder.snapshotId()).toBe(expected);
    } finally {
      folder.cleanup();
    }
  });

  it.each([
    [
      "waits for a due refresh in a Lambda, which freezes after replying",
      "analytics-query",
      "snap2",
    ],
    [
      "answers a due refresh at once locally, where the refresh carries on",
      undefined,
      "snap1",
    ],
  ])("%s", async (_, lambda, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const folder = await handlersOverFolder({
      AWS_LAMBDA_FUNCTION_NAME: lambda,
    });
    try {
      expect(await folder.snapshotId()).toBe("snap1");
      folder.rebuild();
      // Past the store's 5-minute check interval.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      expect(await folder.snapshotId()).toBe(expected);
      // A refresh still loading when cleanup deletes the folder would log into a later test.
      await vi.waitFor(
        async () => expect(await folder.snapshotId()).toBe("snap2"),
        { timeout: 10_000 },
      );
    } finally {
      vi.useRealTimers();
      folder.cleanup();
    }
  });

  it("gives up on a hung S3 request, so a frozen refresh can't stall the snapshot", async () => {
    vi.resetModules();
    const { S3Client } = await import("@aws-sdk/client-s3");
    /** @type {any[]} */
    const clients = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(
      /** @this {any} */
      async function () {
        clients.push(this);
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      },
    );
    try {
      const fresh = await import("./admin-reporting.js");
      const h = fresh.reportingHandlers({ LAKE_BUCKET: "lake" });
      await h.getOverview(event());
      const config = await clients[0].config.requestHandler.configProvider;
      const { S3_TIMEOUTS } = await import("../reporting/contract.js");
      expect(config).toMatchObject(S3_TIMEOUTS);
      expect(S3_TIMEOUTS.socketTimeout).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    [
      "caps a Lambda's first load inside the gateway's 29 s, so it ends as a 503",
      { AWS_LAMBDA_FUNCTION_NAME: "analytics-query" },
      { refreshWaitMs: 3000, firstLoadWaitMs: 20_000 },
    ],
    [
      "leaves a local first load uncapped, since no gateway times it out",
      {},
      { refreshWaitMs: 0, firstLoadWaitMs: 0 },
    ],
  ])("%s", async (_, env, expected) => {
    const { snapshotTimings } = await import("./admin-reporting.js");
    const timings = snapshotTimings(env);
    expect(timings).toMatchObject(expected);
    expect(timings.firstLoadWaitMs).toBeLessThan(29_000);
  });

  it("keeps the first build, whatever env a later call passes", async () => {
    vi.resetModules();
    const fresh = await import("./admin-reporting.js");
    const first = fresh.reportingHandlers({ LAKE_BUCKET: "lake" });
    const later = fresh.reportingHandlers({ INSIGHTS_JOBS_BUCKET: "j" });
    expect(later).toBe(first);
    const res = await later.postExport(event({ body: { dataset: "issues" } }));
    expect(json(res).error).toBe("jobs_unavailable");
  });

  it("reads the projection from INSIGHTS_PROJECTION_DIR, as the local API does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "insights-handler-"));
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      await writeSyntheticProjection(conn, dir);
      vi.resetModules();
      const fresh = await import("./admin-reporting.js");
      const h = fresh.reportingHandlers({
        INSIGHTS_PROJECTION_DIR: dir,
        AWS_ENDPOINT_URL_S3: "http://localhost:4566",
        S3_PUBLIC_PRESIGN_ENDPOINT: "http://localhost:9000",
        INSIGHTS_JOBS_BUCKET: "j",
      });
      const res = await h.getOverview(event());
      expect([res.statusCode, json(res).siteCount]).toEqual([200, 3]);
    } finally {
      conn.closeSync();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["export", "postExport", { dataset: "issues" }],
    ["report", "postReport", { siteIds: ["s1"] }],
  ])(
    "retries a default-month %s for the month it was asked in",
    async (_kind, route, body) => {
      const projection = syntheticProjection();
      const jobStore = memoryJobStore();
      /**
       * @param {string} id
       * @param {string} evaluatedAt
       * @returns {any}
       */
      const handlersOn = (id, evaluatedAt) =>
        createReportingHandlers({
          snapshots: createSnapshotStore({
            source: tablesSource({
              ...projection,
              manifest: { ...projection.manifest, snapshotId: id, evaluatedAt },
            }),
          }),
          jobStore,
          starter: async () => {},
          now: () => NOW,
        });
      // 11 pm on Oct 31 in San Francisco, then the next day's snapshot.
      const first = json(
        await handlersOn("snap1", "2026-11-01T06:00:00.000Z")[route](
          event({ headers: key, body }),
        ),
      );
      expect(first.job.request.month).toBe("2026-10");
      const [record] = [...jobStore.records.values()];
      record.state = "failed";
      const h = handlersOn("snap2", "2026-11-01T19:00:00.000Z");
      const retry = json(await h[route](event({ headers: key, body })));
      expect(retry.job).toMatchObject({
        snapshotId: "snap2",
        request: { month: "2026-10" },
      });
    },
  );

  it("cancels a queued job", async () => {
    const { h } = setup();
    const created = json(
      await h.postExport(event({ headers: key, body: { dataset: "issues" } })),
    );
    const res = await h.cancelJob(
      event({ path: { jobId: created.job.jobId } }),
    );
    expect(json(res).job.state).toBe("cancelled");
  });
});
