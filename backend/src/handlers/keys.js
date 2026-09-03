// Single-table key builders for the perimeter-check item types. Centralised so
// the `SITE#`/`CHECK#`/`ART#`/`ANALYSIS#`/`TASK#` string conventions live in one
// place (see docs/dynamodb-data-model.md § Item types + GSIs) and the handlers,
// worker, and tests all agree on them. Pure string assembly — no I/O.

/**
 * @typedef {object} PrimaryKey
 * @property {string} pk
 * @property {string} sk
 */

/**
 * Tenant partition key shared by every item for a site.
 * @param {string} siteId
 * @returns {string}
 */
export const sitePk = (siteId) => `SITE#${siteId}`;

/**
 * Device identity item — one per registered tablet (AP4 / identity model).
 * @param {string} siteId
 * @param {string} deviceId
 * @returns {PrimaryKey}
 */
export const deviceKey = (siteId, deviceId) => ({
  pk: sitePk(siteId),
  sk: `DEVICE#${deviceId}`,
});

/**
 * Sort-key prefix that lists a site's devices (AP4).
 * @param {string} siteId
 * @returns {string}
 */
export const devicePrefix = (siteId) => sitePk(siteId);

/**
 * CHECK header — one item per full perimeter run (all sides).
 * @param {string} siteId
 * @param {string} checkId
 * @returns {PrimaryKey}
 */
export const checkHeaderKey = (siteId, checkId) => ({
  pk: sitePk(siteId),
  sk: `CHECK#${checkId}`,
});

/**
 * Artifact (one per captured photo/audio/text, grouped by side).
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} side
 * @param {string} artifactId
 * @returns {PrimaryKey}
 */
export const artifactKey = (siteId, checkId, side, artifactId) => ({
  pk: sitePk(siteId),
  sk: `CHECK#${checkId}#ART#${side}#${artifactId}`,
});

/**
 * Analysis (one per analyzed artifact; raw adapted service output).
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} artifactId
 * @returns {PrimaryKey}
 */
export const analysisKey = (siteId, checkId, artifactId) => ({
  pk: sitePk(siteId),
  sk: `CHECK#${checkId}#ANALYSIS#${artifactId}`,
});

/**
 * Action item / task.
 * @param {string} siteId
 * @param {string} taskId
 * @returns {PrimaryKey}
 */
export const taskKey = (siteId, taskId) => ({
  pk: sitePk(siteId),
  sk: `TASK#${taskId}`,
});

/**
 * Sort-key prefix that gathers a check's header + all its artifacts + analyses
 * for the single-query detail read (AP7): `begins_with(sk, checkChildrenPrefix)`.
 * @param {string} checkId
 * @returns {string}
 */
export const checkChildrenPrefix = (checkId) => `CHECK#${checkId}`;

/**
 * Sort-key prefix that gathers only a check's ANALYSIS# items — what
 * `completeCheck` folds into the perimeter scorecard: `begins_with(sk, …)`.
 * @param {string} checkId
 * @returns {string}
 */
export const checkAnalysisPrefix = (checkId) => `CHECK#${checkId}#ANALYSIS#`;

/**
 * Sort-key prefix that gathers only a check's ART# items (one per captured
 * photo, across all sides): `begins_with(sk, …)`.
 * @param {string} checkId
 * @returns {string}
 */
export const checkArtifactPrefix = (checkId) => `CHECK#${checkId}#ART#`;

// GSI names — must match the index names the table is created with: Terraform
// (infra/modules/app/main.tf) and the local harness (scripts/lib/ensure-infra.mjs)
// both create them uppercase, and DynamoDB index names are case-sensitive, so
// these constants must be uppercase too. GSI1 backs timelines, GSI2 backs the
// per-status staff worklist, and GSI4/GSI5 back condition review queues.
export const GSI1_NAME = "GSI1";

/** The per-status worklist index (AP10); see taskWorklistDateGsi. */
export const GSI2_NAME = "GSI2";

/** Conditions by site/date/severity. */
export const GSI4_NAME = "GSI4";

/** Sparse index for conditions not yet fully translated into tasks. */
export const GSI5_NAME = "GSI5";

/**
 * GSI1 (checks timeline) attributes for a check header. Sparse — only headers
 * carry these — so the checks-list query (AP6) never filters.
 * @param {string} siteId
 * @param {string} startedAt ISO-8601 timestamp; sorts chronologically
 * @returns {{ gsi1pk: string, gsi1sk: string }}
 */
export const checkTimelineGsi = (siteId, startedAt) => ({
  gsi1pk: sitePk(siteId),
  gsi1sk: startedAt,
});

/**
 * GSI2 partition key for a site's worklist at one status — the value the reader
 * (AP10) queries and the writer stamps. One place for the convention.
 * @param {string} siteId
 * @param {string} status
 * @returns {string}
 */
export const taskWorklistPk = (siteId, status) =>
  `SITE#${siteId}#TASK#${status}`;

/**
 * Assessment report item.
 * @param {string} siteId
 * @param {string} assessmentId
 * @returns {PrimaryKey}
 */
export const assessmentKey = (siteId, assessmentId) => ({
  pk: sitePk(siteId),
  sk: `ASSESSMENT#${assessmentId}`,
});

/**
 * Condition item under one assessment.
 * @param {string} siteId
 * @param {string} assessmentId
 * @param {string} conditionId
 * @returns {PrimaryKey}
 */
export const conditionKey = (siteId, assessmentId, conditionId) => ({
  pk: sitePk(siteId),
  sk: `ASSESSMENT#${assessmentId}#COND#${conditionId}`,
});

/**
 * Sort-key prefix that gathers conditions for one assessment.
 * @param {string} assessmentId
 * @returns {string}
 */
export const assessmentConditionPrefix = (assessmentId) =>
  `ASSESSMENT#${assessmentId}#COND#`;

/**
 * GSI1 attributes for assessment report timeline reads.
 * @param {string} siteId
 * @param {string} reportedAt ISO-8601 timestamp
 * @param {string} assessmentId
 * @returns {{ gsi1pk: string, gsi1sk: string }}
 */
export const assessmentTimelineGsi = (siteId, reportedAt, assessmentId) => ({
  gsi1pk: `SITE#${siteId}#ASSESSMENT`,
  gsi1sk: `${reportedAt}#${assessmentId}`,
});

/**
 * GSI2 attributes for date-first task worklist reads.
 * @param {string} siteId
 * @param {string} status
 * @param {string} kind
 * @param {number} severity
 * @param {string} createdAt ISO-8601 timestamp
 * @param {string} taskId
 * @returns {{ gsi2pk: string, gsi2sk: string }}
 */
export const taskWorklistDateGsi = (
  siteId,
  status,
  kind,
  severity,
  createdAt,
  taskId,
) => ({
  gsi2pk: taskWorklistPk(siteId, status),
  gsi2sk: `${createdAt}#${kind}#${severity}#${taskId}`,
});

/**
 * GSI4 attributes for condition timeline reads by severity.
 * @param {string} siteId
 * @param {number} severity
 * @param {string} reportedAt ISO-8601 timestamp
 * @param {string} assessmentId
 * @param {string} conditionId
 * @returns {{ gsi4pk: string, gsi4sk: string }}
 */
export const conditionTimelineGsi = (
  siteId,
  severity,
  reportedAt,
  assessmentId,
  conditionId,
) => ({
  gsi4pk: `SITE#${siteId}#CONDITION#SEV#${severity}`,
  gsi4sk: `${reportedAt}#${assessmentId}#${conditionId}`,
});

/**
 * GSI5 attributes for unresolved condition reads.
 * @param {string} siteId
 * @param {number} severity
 * @param {string} reportedAt ISO-8601 timestamp
 * @param {string} assessmentId
 * @param {string} conditionId
 * @returns {{ gsi5pk: string, gsi5sk: string }}
 */
export const unresolvedConditionGsi = (
  siteId,
  severity,
  reportedAt,
  assessmentId,
  conditionId,
) => ({
  gsi5pk: `SITE#${siteId}#CONDITION#UNRESOLVED`,
  gsi5sk: `${reportedAt}#SEV#${severity}#${assessmentId}#${conditionId}`,
});
