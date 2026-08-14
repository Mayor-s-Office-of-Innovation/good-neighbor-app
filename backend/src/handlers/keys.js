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

// GSI names — the single source of truth the Step E Terraform must match when
// it creates the indexes. GSI1 backs the newest-first checks list (AP6); GSI2
// backs the per-status staff worklist (AP10, its reader lands with that step).
export const GSI1_NAME = "gsi1";

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
 * GSI2 (site worklist) attributes for a task. Partitioned by status so the
 * staff worklist (AP10) reads one status at a time, sorted by severity#createdAt.
 * @param {string} siteId
 * @param {string} status
 * @param {number} severity
 * @param {string} createdAt ISO-8601 timestamp
 * @returns {{ gsi2pk: string, gsi2sk: string }}
 */
export const taskWorklistGsi = (siteId, status, severity, createdAt) => ({
  gsi2pk: `SITE#${siteId}#TASK#${status}`,
  gsi2sk: `${severity}#${createdAt}`,
});
