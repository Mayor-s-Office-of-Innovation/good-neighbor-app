// Served by the analytics-query Lambda from one in-memory snapshot, so every number on a page agrees.

import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { jsonResponse, readJsonBody } from "../http.js";
import { addDays } from "../lib/pacific-dates.js";
import { adminPrincipal } from "../lib/admin-auth.js";
import { logServerError } from "../lib/log-server-error.js";
import { toCsv } from "../reporting/api/csv.js";
import {
  inProcessStarter,
  s3JobStore,
  sqsStarter,
} from "../reporting/api/job-store.js";
import { createJobs } from "../reporting/api/jobs.js";
import {
  checkDetail,
  exportRowCount,
  exportRows,
  issueDetail,
  listChecks,
  listIssues,
  overview,
  reportDataset,
  scopeOptions,
  siteDetail,
  trends,
} from "../reporting/api/read-model.js";
import {
  LIMITS,
  SITE_DIMENSIONS,
  isRequestError,
  parseIdList,
  parseListQuery,
  parsePeriodParams,
  parseSiteFilter,
  requestError,
  withDefaultMonth,
} from "../reporting/api/requests.js";
import {
  createSnapshotStore,
  dirSource,
  s3Source,
} from "../reporting/api/snapshot.js";

/** @typedef {import("aws-lambda").APIGatewayProxyEventV2} Event */
/** @typedef {import("../reporting/api/snapshot.js").Snapshot} Snapshot */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const EXPORT_DATASETS = ["issues", "checks", "sites"];
// Params a request may carry; anything else is dropped before it's stored.
const PERIOD_PARAMS = [
  "period",
  "month",
  "quarter",
  "year",
  "startYear",
  "from",
  "to",
];
const LIST_PARAMS = [
  "siteIds",
  "q",
  ...SITE_DIMENSIONS,
  "severityBand",
  "responseState",
  "source",
  "issueStatus",
  "category",
  "state",
  "show",
  "publicContact",
  "siteContact",
  "sort",
  "dir",
];

/**
 * @param {Record<string, unknown>} params
 * @param {string[]} keys
 */
const pick = (params, keys) =>
  Object.fromEntries(
    keys.filter((k) => params[k] !== undefined).map((k) => [k, params[k]]),
  );

/**
 * The snapshot's own data start, so the default month moves with launch.
 * @param {Snapshot} snap
 * @param {Record<string, unknown>} params
 */
const intervalFor = (snap, params) =>
  parsePeriodParams(params, snap.manifest.evaluatedAt, snap.coverageStart);

/**
 * @param {Snapshot} snap
 * @param {Record<string, unknown>} params
 */
function exportRequest(snap, params) {
  const dataset = String(params.dataset ?? "");
  if (!EXPORT_DATASETS.includes(dataset)) throw requestError("invalid_dataset");
  const kind = /** @type {"issues" | "checks" | "sites"} */ (dataset);
  return {
    dataset: kind,
    interval: intervalFor(snap, params),
    filter: parseSiteFilter(params),
    list: parseListQuery(kind, {
      ...params,
      limit: undefined,
      cursor: undefined,
    }),
  };
}

/**
 * @param {Snapshot} snap
 * @param {Record<string, unknown>} params
 */
function reportRequest(snap, params) {
  const siteIds = parseIdList(params.siteIds ?? [], LIMITS.maxReportSites);
  if (siteIds.some((id) => !snap.sitesById.has(id)))
    throw requestError("unknown_site");
  return {
    siteIds,
    interval: intervalFor(snap, params),
  };
}

/**
 * @param {"export" | "report"} kind
 * @param {Record<string, any>} params
 * @param {Snapshot} snap
 * @param {number} now
 * @param {number} maxExportRows
 * @returns {import("../reporting/api/jobs.js").JobOutput}
 */
function renderJob(kind, params, snap, now, maxExportRows) {
  const stamp = snap.snapshotId.replace(/[^A-Za-z0-9-]/g, "-");
  // endDay is exclusive; a name ending on it would claim one day too many.
  const span = (/** @type {{ startDay: string, endDay: string }} */ i) =>
    `${i.startDay}-to-${addDays(i.endDay, -1)}`;
  if (kind === "export") {
    const req = exportRequest(snap, params);
    const { columns, rows } = exportRows(snap, req);
    if (rows.length > maxExportRows)
      throw requestError("export_too_large", 413);
    return {
      body: toCsv(columns, rows),
      contentType: "text/csv; charset=utf-8",
      filename: `insights-${req.dataset}-${span(req.interval)}-${stamp}.csv`,
      rows: rows.length,
    };
  }
  const req = reportRequest(snap, params);
  const dataset = reportDataset(snap, { ...req, now });
  return {
    body: JSON.stringify(dataset),
    contentType: "application/json",
    filename: `insights-report-${span(req.interval)}-${stamp}.json`,
    rows: req.siteIds.length,
    dataQuality: dataset.meta.dataQuality,
  };
}

/**
 * @param {{
 *   snapshots: ReturnType<typeof createSnapshotStore>,
 *   jobStore: import("../reporting/api/jobs.js").JobStore | null,
 *   starter: (ref: { ownerKey: string, jobId: string }) => Promise<void>,
 *   now?: () => number,
 *   maxExportRows?: number,
 * }} deps
 */
export function createReportingHandlers({
  snapshots,
  jobStore,
  starter,
  now = Date.now,
  maxExportRows = LIMITS.maxExportRows,
}) {
  const jobs =
    jobStore &&
    createJobs({
      store: jobStore,
      snapshots,
      starter,
      now,
      render: async (kind, params, snap) =>
        renderJob(kind, params, snap, now(), maxExportRows),
      onError: (err, ref) =>
        logServerError("admin-reporting", /** @type {Error} */ (err), {
          extra: { jobId: ref.jobId },
        }),
    });
  const needJobs = () => {
    if (!jobs) throw requestError("jobs_unavailable", 503);
    return jobs;
  };

  // One gate for every route, so none can skip the capability check.
  /**
   * @param {Event} event
   * @param {(ctx: { params: Record<string, unknown>, ownerKey: string }) => Promise<{ statusCode?: number, body: unknown }>} work
   */
  const guarded = async (event, work) => {
    const principal = adminPrincipal(event);
    if (!principal.capabilities.viewInsights)
      return jsonResponse(403, { error: "forbidden" });
    const owner = principal.subject || principal.username || principal.email;
    if (!owner) return jsonResponse(403, { error: "forbidden" });
    // Hashed, so the job store's keys don't carry a person's identifier.
    const ownerKey = createHash("sha256")
      .update(owner)
      .digest("hex")
      .slice(0, 32);
    try {
      /** @type {Record<string, unknown>} */
      let params = { ...(event.queryStringParameters ?? {}) };
      if (event.body) {
        let body;
        try {
          body = readJsonBody(event);
        } catch {
          throw requestError("invalid_json");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw requestError("invalid_json");
        params = {
          ...params,
          .../** @type {Record<string, unknown>} */ (body),
        };
      }
      const { statusCode = 200, body } = await work({ params, ownerKey });
      return jsonResponse(statusCode, body);
    } catch (err) {
      if (isRequestError(err)) {
        // A 503 like snapshot_contract_mismatch is ours to fix, so log it.
        if (err.statusCode >= 500)
          logServerError("admin-reporting", err, {
            extra: { routeKey: /** @type {any} */ (event).routeKey },
          });
        return jsonResponse(err.statusCode, { error: err.code });
      }
      logServerError("admin-reporting", /** @type {Error} */ (err), {
        extra: { routeKey: /** @type {any} */ (event).routeKey },
      });
      return jsonResponse(502, { error: "reporting_failed" });
    }
  };

  /**
   * @param {Event} event
   * @param {string} name
   */
  const pathParam = (event, name) => {
    const value = event.pathParameters?.[name];
    if (!value) throw requestError(`invalid_${name}`);
    return value;
  };

  // A detail link carries the Site when two Sites share an Issue or Check ID.
  /** @param {Record<string, unknown>} params */
  const optionalSiteId = (params) => {
    if (params.siteId === undefined || params.siteId === "") return undefined;
    const value = params.siteId;
    if (typeof value !== "string" || value.length > LIMITS.maxFilterLength)
      throw requestError("invalid_siteId");
    return value;
  };

  /** @param {Event} event */
  const idempotencyKey = (event) => {
    const value = event.headers?.["idempotency-key"] ?? "";
    if (!IDEMPOTENCY_KEY.test(value))
      throw requestError("idempotency_key_required");
    return value;
  };

  /**
   * @param {"sites" | "issues" | "checks"} kind
   * @param {Snapshot} snap
   * @param {Record<string, unknown>} params
   */
  const listArgs = (kind, snap, params) => ({
    interval: intervalFor(snap, params),
    filter: parseSiteFilter(params),
    list: parseListQuery(kind, params),
    now: now(),
  });

  return {
    /** @param {Event} event */
    getOverview: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        return { body: overview(snap, listArgs("sites", snap, params)) };
      }),

    /** @param {Event} event */
    getSite: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        return {
          body: siteDetail(snap, pathParam(event, "siteId"), {
            interval: intervalFor(snap, params),
            now: now(),
          }),
        };
      }),

    /** @param {Event} event */
    listIssues: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        return { body: listIssues(snap, listArgs("issues", snap, params)) };
      }),

    /** @param {Event} event */
    getIssue: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        return {
          body: issueDetail(snap, pathParam(event, "issueId"), {
            siteId: optionalSiteId(params),
            now: now(),
          }),
        };
      }),

    /** @param {Event} event */
    listChecks: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        return { body: listChecks(snap, listArgs("checks", snap, params)) };
      }),

    /** @param {Event} event */
    getCheck: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        return {
          body: checkDetail(snap, pathParam(event, "checkId"), {
            siteId: optionalSiteId(params),
            now: now(),
          }),
        };
      }),

    /** @param {Event} event */
    getScopeOptions: (event) =>
      guarded(event, async ({ params }) => ({
        body: scopeOptions(await snapshots.current(), {
          now: now(),
          include: typeof params.include === "string" ? params.include : "",
        }),
      })),

    /** @param {Event} event */
    postTrends: (event) =>
      guarded(event, async ({ params }) => {
        const snap = await snapshots.current();
        const raw = /** @type {Record<string, any>} */ (params.scope ?? {});
        if (typeof raw !== "object" || Array.isArray(raw))
          throw requestError("invalid_scope");
        /** @type {Record<string, string[]>} */
        const groups = {};
        for (const [dim, values] of Object.entries(raw.groups ?? {})) {
          if (!SITE_DIMENSIONS.includes(dim))
            throw requestError("invalid_group");
          if (
            !Array.isArray(values) ||
            values.length > LIMITS.maxGroupValues ||
            values.some(
              (v) => typeof v !== "string" || v.length > LIMITS.maxFilterLength,
            )
          )
            throw requestError("invalid_group");
          groups[dim] = values;
        }
        const siteIds =
          raw.siteIds === undefined
            ? undefined
            : parseIdList(raw.siteIds, LIMITS.maxTrendSites);
        // A typo'd or removed Site would otherwise chart as a quiet one.
        if (siteIds?.some((id) => !snap.sitesById.has(id)))
          throw requestError("unknown_site");
        const breakdown =
          params.breakdown === undefined ? undefined : String(params.breakdown);
        if (breakdown !== undefined && !SITE_DIMENSIONS.includes(breakdown))
          throw requestError("invalid_breakdown");
        return {
          body: trends(snap, {
            interval: intervalFor(snap, params),
            scope: { siteIds, groups },
            breakdown,
            now: now(),
          }),
        };
      }),

    /** @param {Event} event */
    postExport: (event) =>
      guarded(event, async ({ params, ownerKey }) => {
        const queue = needJobs();
        const key = idempotencyKey(event);
        const stored = pick(params, [
          "dataset",
          ...PERIOD_PARAMS,
          ...LIST_PARAMS,
        ]);
        const { statusCode, job } = await queue.create(ownerKey, {
          kind: "export",
          params: stored,
          idempotencyKey: key,
          // Refused before it is queued, on the snapshot the job will read.
          check: (snap, asked) => {
            const resolved = withDefaultMonth(asked, snap.manifest.evaluatedAt);
            const rows = exportRowCount(snap, exportRequest(snap, resolved));
            if (rows > maxExportRows)
              throw requestError("export_too_large", 413);
            return resolved;
          },
        });
        return { statusCode, body: { job } };
      }),

    /** @param {Event} event */
    postReport: (event) =>
      guarded(event, async ({ params, ownerKey }) => {
        const queue = needJobs();
        const key = idempotencyKey(event);
        const stored = pick(params, ["siteIds", ...PERIOD_PARAMS]);
        const { statusCode, job } = await queue.create(ownerKey, {
          kind: "report",
          params: stored,
          idempotencyKey: key,
          check: (snap, asked) => {
            const resolved = withDefaultMonth(asked, snap.manifest.evaluatedAt);
            reportRequest(snap, resolved);
            return resolved;
          },
        });
        return { statusCode, body: { job } };
      }),

    /** @param {Event} event */
    getJob: (event) =>
      guarded(event, async ({ ownerKey }) => ({
        body: {
          job: await needJobs().get(ownerKey, pathParam(event, "jobId")),
        },
      })),

    /** @param {Event} event */
    cancelJob: (event) =>
      guarded(event, async ({ ownerKey }) => ({
        body: {
          job: await needJobs().cancel(ownerKey, pathParam(event, "jobId")),
        },
      })),

    // Kept off the request, so a large file can't hit the gateway's 29 s cap.
    /** @param {{ ownerKey: string, jobId: string }} ref */
    runJob: (ref) => needJobs().run(ref),
  };
}

/** @type {ReturnType<typeof createReportingHandlers> | null} */
let fromEnv = null;

// Built on first use, so the module loads where the env isn't set; later calls
// get the first build, whatever env they pass.
/** @param {NodeJS.ProcessEnv} [env] */
export function reportingHandlers(env = process.env) {
  if (fromEnv) return fromEnv;
  const lakeBucket = env.LAKE_BUCKET ?? "";
  // The lake is read-only here and a Lambda stops after replying, so jobs get their own bucket and queue.
  const jobsReady =
    Boolean(env.INSIGHTS_JOBS_BUCKET) &&
    Boolean(env.INSIGHTS_JOBS_QUEUE_URL || !env.AWS_LAMBDA_FUNCTION_NAME);
  const s3 = new S3Client(
    env.AWS_ENDPOINT_URL_S3 ? { forcePathStyle: true } : {},
  );
  const presignClient = env.S3_PUBLIC_PRESIGN_ENDPOINT
    ? new S3Client({
        endpoint: env.S3_PUBLIC_PRESIGN_ENDPOINT,
        forcePathStyle: true,
      })
    : s3;
  const source = env.INSIGHTS_PROJECTION_DIR
    ? dirSource(env.INSIGHTS_PROJECTION_DIR)
    : s3Source({ s3, bucket: lakeBucket });
  /** @type {ReturnType<typeof createReportingHandlers>} */
  let handlers;
  const starter = env.INSIGHTS_JOBS_QUEUE_URL
    ? sqsStarter({
        sqs: new SQSClient({}),
        queueUrl: env.INSIGHTS_JOBS_QUEUE_URL,
      })
    : inProcessStarter(() => handlers.runJob);
  handlers = createReportingHandlers({
    snapshots: createSnapshotStore({
      source,
      onError: (err) =>
        logServerError("admin-reporting", /** @type {Error} */ (err), {
          extra: { step: "snapshot-refresh" },
        }),
    }),
    jobStore: jobsReady
      ? s3JobStore({
          s3,
          presignClient,
          bucket: /** @type {string} */ (env.INSIGHTS_JOBS_BUCKET),
        })
      : null,
    starter,
  });
  fromEnv = handlers;
  return handlers;
}

/**
 * @param {keyof ReturnType<typeof createReportingHandlers>} name
 * @returns {(event: any) => Promise<any>}
 */
const route = (name) => (event) =>
  /** @type {any} */ (reportingHandlers())[name](event);

export const getReportingOverview = route("getOverview");
export const getReportingSite = route("getSite");
export const listReportingIssues = route("listIssues");
export const getReportingIssue = route("getIssue");
export const listReportingChecks = route("listChecks");
export const getReportingCheck = route("getCheck");
export const getReportingScopeOptions = route("getScopeOptions");
export const postReportingTrends = route("postTrends");
export const postReportingExport = route("postExport");
export const postInsightsReport = route("postReport");
export const getReportJob = route("getJob");
export const cancelReportJob = route("cancelJob");
export const runReportJob = route("runJob");

/** insights-mock-shape.test.js holds the admin E2E mock to this list. */
export const reportingRoutes = Object.freeze({
  "GET /admin/v1/reporting/overview": getReportingOverview,
  "GET /admin/v1/reporting/sites/{siteId}": getReportingSite,
  "GET /admin/v1/reporting/issues": listReportingIssues,
  "GET /admin/v1/reporting/issues/{issueId}": getReportingIssue,
  "GET /admin/v1/reporting/checks": listReportingChecks,
  "GET /admin/v1/reporting/checks/{checkId}": getReportingCheck,
  "GET /admin/v1/reporting/scope-options": getReportingScopeOptions,
  "POST /admin/v1/reporting/trends": postReportingTrends,
  "POST /admin/v1/reporting/exports": postReportingExport,
  "POST /admin/v1/reports/insights": postInsightsReport,
  "GET /admin/v1/reports/{jobId}": getReportJob,
  "DELETE /admin/v1/reports/{jobId}": cancelReportJob,
});
