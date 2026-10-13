/*
  Site manager reports — the read side of the Checks / Issues / Actions
  views. Manager-only, site-scoped by the token, and served straight from
  the operational table: every query is one GSI1 timeline partition per
  site over a Pacific calendar period, so a quarter is one range query, not
  a scan.

    GET /app/v1/manager/reports/checks?period=&start=        AP27
    GET /app/v1/manager/reports/tasks?period=&start=         AP27
    GET /app/v1/manager/reports/task-updates?period=&start=  AP28

  `period` is week | month | quarter; `start` is any Pacific day key inside
  the wanted period (default: today). Each response carries the resolved
  period and the previous period's totals so the views can show deltas.

  The checks report returns day summaries only (never raw headers): a
  quarter of headers is hundreds of KB that the chart does not need. The
  day detail screen reads AP7 per check instead.
*/
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveAccessLevel, deriveSiteId } from "../lib/principal.js";
import {
  dayKeysBetween,
  isDayKey,
  isPeriodKind,
  pacificDayStartIso,
  pacificToday,
  periodContaining,
  previousPeriod,
} from "../lib/pacific-dates.js";
import {
  requirementFromCompliance,
  requiredOnResolver,
  summarizeCheckDays,
} from "../domain/check-compliance.js";
import {
  GSI1_NAME,
  siteMetaKey,
  sitePk,
  taskTimelinePk,
  taskUpdateTimelinePk,
} from "./keys.js";

/** Task attributes the reports need; the rest of the item stays server-side. */
const TASK_PROJECTION = [
  "taskId",
  "shortId",
  "checkId",
  "assessmentId",
  "conditionId",
  "ruleId",
  "kind",
  "type",
  "status",
  "category",
  "analyzerCategory",
  "userFriendlyLabel",
  "label",
  "latestUpdateLabel",
  "completionMethod",
  "inProgressActionKind",
  "cannotDo",
  "agency",
  "primaryInProgressAgency",
  "buttons",
  "sourceArtifactIds",
  "source",
  "createdAt",
  "updatedAt",
  "inProgressAt",
  "completedAt",
  "resolvedAt",
  "supersededAt",
];

/** Update-event attributes the reports need. */
const UPDATE_PROJECTION = [
  "taskId",
  "updateId",
  "type",
  "label",
  "occurredAt",
  "documentationState",
  "presencePeriod",
  "text",
  "notes",
  "photoKeys",
  "cityHelpNeeded",
];

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @returns {{ period: import("../lib/pacific-dates.js").Period, today: string } | { error: string }}
 */
function resolvePeriod(event) {
  const query = event.queryStringParameters ?? {};
  const kind = query.period ?? "month";
  if (!isPeriodKind(kind)) return { error: "invalid_period" };
  const today = pacificToday();
  const anchor = query.start ?? today;
  if (!isDayKey(anchor)) return { error: "invalid_start" };
  return { period: periodContaining(kind, anchor), today };
}

/**
 * Every item in one GSI1 partition whose sort key falls inside the period.
 * Sort keys start with an ISO instant, so the Pacific day bounds compare
 * lexicographically. The upper bound is exclusive: an item stamped exactly
 * at the next period's first midnight belongs to that period.
 * @param {object} input
 * @param {string} input.tableName
 * @param {string} input.partition
 * @param {import("../lib/pacific-dates.js").Period} input.period
 * @param {string[]} [input.projection]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function queryTimeline({ tableName, partition, period, projection }) {
  const from = pacificDayStartIso(period.start);
  const to = pacificDayStartIso(period.endExclusive);
  /** @type {Array<Record<string, any>>} */
  const items = [];
  /** @type {Record<string, any> | undefined} */
  let startKey;
  const names = projection
    ? Object.fromEntries(projection.map((name) => [`#${name}`, name]))
    : undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1_NAME,
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": partition,
          ":from": from,
          ":to": to,
        },
        ...(names
          ? {
              ProjectionExpression: Object.keys(names).join(", "),
              ExpressionAttributeNames: names,
            }
          : {}),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      if (String(item.gsi1sk ?? "") < to || !item.gsi1sk) items.push(item);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/**
 * @param {string} tableName
 * @param {string} siteId
 * @returns {Promise<Record<string, any>>}
 */
async function readSiteMeta(tableName, siteId) {
  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: siteMetaKey(siteId) }),
  );
  return result.Item ?? {};
}

/**
 * Every version of the site's compliance terms (`COMPLIANCE_TERMS#`), so
 * each reported day is judged by the cadence in force then. A site has a
 * handful of versions at most, so one page is enough.
 * @param {string} tableName
 * @param {string} siteId
 * @returns {Promise<Array<import("../domain/check-compliance.js").ComplianceTermsVersion>>}
 */
async function readComplianceTerms(tableName, siteId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": sitePk(siteId),
        ":prefix": "COMPLIANCE_TERMS#",
      },
      ProjectionExpression:
        "effectiveStart, expiresOnExclusive, requiredChecksPerDay, #status",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  return /** @type {any[]} */ (result.Items ?? []);
}

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @returns {{ siteId: string, tableName: string, period: import("../lib/pacific-dates.js").Period, today: string } | { response: ReturnType<typeof jsonResponse> }}
 */
function reportContext(event) {
  if (deriveAccessLevel(event) !== "manager") {
    return {
      response: jsonResponse(403, { error: "manager_access_required" }),
    };
  }
  const resolved = resolvePeriod(event);
  if ("error" in resolved) {
    return { response: jsonResponse(400, { error: resolved.error }) };
  }
  return {
    siteId: deriveSiteId(event),
    tableName: getDynamoTableName(),
    period: resolved.period,
    today: resolved.today,
  };
}

/**
 * GET /app/v1/manager/reports/checks — per-day compliance for one period,
 * with the previous period's totals for the delta line.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getChecksReport = async (event) => {
  const ctx = reportContext(event);
  if ("response" in ctx) return ctx.response;
  const { siteId, tableName, period, today } = ctx;
  const previous = previousPeriod(period);
  const partition = sitePk(siteId);

  const [site, currentChecks, previousChecks, terms] = await Promise.all([
    readSiteMeta(tableName, siteId),
    queryTimeline({ tableName, partition, period }),
    queryTimeline({ tableName, partition, period: previous }),
    readComplianceTerms(tableName, siteId),
  ]);
  const requirement = requirementFromCompliance(site.compliance);
  // The projection describes today's terms (for the headline); each day is
  // judged by the version that applied then. Recorded terms, even if the
  // projection has since been nulled, mean the cadence is not assumed.
  const hasTerms = terms.some((v) => v.status !== "cancelled");
  if (hasTerms) requirement.assumed = false;
  const resolveRequired = requiredOnResolver(requirement, terms);

  const current = summarizeCheckDays({
    checks: currentChecks,
    dayKeys: dayKeysBetween(period.start, period.endExclusive),
    today,
    requirement,
    resolveRequired,
  });
  const prior = summarizeCheckDays({
    checks: previousChecks,
    dayKeys: dayKeysBetween(previous.start, previous.endExclusive),
    today,
    requirement,
    resolveRequired,
  });

  return jsonResponse(200, {
    period,
    today,
    requirement,
    days: current.days,
    totals: current.totals,
    previous: { ...previous, totals: prior.totals },
  });
};

/**
 * GET /app/v1/manager/reports/tasks — every task created in the period,
 * oldest first, whatever its status now.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getTasksReport = async (event) => {
  const ctx = reportContext(event);
  if ("response" in ctx) return ctx.response;
  const { siteId, tableName, period, today } = ctx;
  const previous = previousPeriod(period);
  const partition = taskTimelinePk(siteId);
  const [tasks, previousTasks] = await Promise.all([
    queryTimeline({
      tableName,
      partition,
      period,
      projection: TASK_PROJECTION,
    }),
    queryTimeline({
      tableName,
      partition,
      period: previous,
      projection: ["taskId", "status"],
    }),
  ]);
  // Same definition of an issue as the current list: a superseded task was
  // replaced by an amendment and is not an issue in its own right.
  const previousCount = previousTasks.filter(
    (task) => task.status !== "superseded",
  ).length;
  return jsonResponse(200, {
    period,
    today,
    tasks,
    previous: { ...previous, count: previousCount },
  });
};

/**
 * GET /app/v1/manager/reports/task-updates — every task update event that
 * happened in the period, across all tasks, oldest first.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getTaskUpdatesReport = async (event) => {
  const ctx = reportContext(event);
  if ("response" in ctx) return ctx.response;
  const { siteId, tableName, period, today } = ctx;
  const previous = previousPeriod(period);
  const partition = taskUpdateTimelinePk(siteId);
  const [updates, previousUpdates] = await Promise.all([
    queryTimeline({
      tableName,
      partition,
      period,
      projection: UPDATE_PROJECTION,
    }),
    queryTimeline({
      tableName,
      partition,
      period: previous,
      projection: ["updateId"],
    }),
  ]);
  return jsonResponse(200, {
    period,
    today,
    updates,
    previous: { ...previous, count: previousUpdates.length },
  });
};
