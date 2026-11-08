// A small synthetic projection for the reporting API tests and the admin
// mock's shape check, built through the real rules so its numbers are real.

import { buildProjection } from "../projection.js";
import { buildFromRows } from "../test-build.js";

export const TEST_EVALUATED_AT = "2026-11-04T19:00:00.000Z";
export const TEST_AS_OF = "2026-11-04T18:00:00.000Z";

/**
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} completedAt
 * @param {Record<string, any>} [extra]
 */
const check = (siteId, checkId, completedAt, extra = {}) => ({
  siteId,
  checkId,
  status: "completed",
  flowType: "perimeter",
  startedAt: new Date(Date.parse(completedAt) - 600_000).toISOString(),
  completedAt,
  synthesizedAt: null,
  ...extra,
});

/**
 * @param {string} siteId
 * @param {string} taskId
 * @param {string} checkId
 * @param {string} createdAt
 * @param {number} severity
 * @param {Record<string, any>} [extra]
 */
const task = (siteId, taskId, checkId, createdAt, severity, extra = {}) => ({
  siteId,
  taskId,
  status: "open",
  createdAt,
  category: severity >= 4 ? "Unsecured gate" : "Debris",
  severity,
  kind: "onsite",
  type: "onsite",
  checkId,
  assessmentId: null,
  conditionId: null,
  inProgressAt: null,
  completedAt: null,
  resolvedAt: null,
  updatedAt: createdAt,
  ...extra,
});

/**
 * @param {string} siteId
 * @param {Record<string, any>} extra
 */
const site = (siteId, extra) => ({
  siteId,
  name: `Synthetic Site ${siteId.slice(1)}`,
  status: "active",
  siteType: "shelter",
  providerId: "v1",
  leadProgramId: "p1",
  oversight: {
    managingCityDepartment: "Example Department",
    cityProgramManagerId: "pm1",
  },
  location: { latitude: 37.77, longitude: -122.41 },
  perimeter: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...extra,
});

/** @returns {import("../projection.js").ProjectionInputs} */
export function syntheticInputs() {
  const checks = [
    check("s1", "c1", "2026-10-02T17:00:00.000Z"),
    check("s1", "c2", "2026-10-10T17:00:00.000Z"),
    check("s1", "c3", "2026-10-20T17:00:00.000Z", {
      flowType: "single-problem",
    }),
    check("s1", "c4", "2026-11-03T17:00:00.000Z"),
    check("s1", "c5", "2026-11-04T16:00:00.000Z", {
      status: "in_progress",
      completedAt: null,
    }),
    check("s2", "c6", "2026-09-15T17:00:00.000Z"),
    check("s2", "c7", "2026-10-05T17:00:00.000Z"),
    check("s3", "c8", "2026-10-06T17:00:00.000Z"),
  ];
  const tasks = [
    // Answered within 72 hours.
    task("s1", "t1", "c1", "2026-10-02T17:00:00.000Z", 4),
    // Never answered: overdue.
    task("s1", "t2", "c2", "2026-10-10T17:00:00.000Z", 2),
    task("s1", "t3", "c3", "2026-10-20T17:00:00.000Z", 5, {
      status: "completed",
      inProgressAt: "2026-10-21T17:00:00.000Z",
      completedAt: "2026-10-22T17:00:00.000Z",
      resolvedAt: "2026-10-22T17:00:00.000Z",
    }),
    // Created yesterday: still awaiting.
    task("s1", "t4", "c4", "2026-11-03T17:00:00.000Z", 3),
    // Answered after four days: late.
    task("s2", "t5", "c7", "2026-10-05T17:00:00.000Z", 3, {
      status: "in_progress",
      inProgressAt: "2026-10-09T17:00:00.000Z",
    }),
    task("s2", "t6", "c6", "2026-09-15T17:00:00.000Z", 1, {
      status: "in_progress",
      inProgressAt: "2026-09-15T18:00:00.000Z",
    }),
  ];
  const updates = [
    {
      siteId: "s1",
      taskId: "t1",
      type: "311_ticket_filed",
      occurredAt: "2026-10-03T17:00:00.000Z",
    },
  ];
  const sites = [
    site("s1", {
      publicContact: { email: "desk@example.org", phone: "415-555-0100" },
      // Private: tests check it never reaches a reply.
      primaryContact: {
        firstName: "Synthetic",
        lastName: "Lead",
        email: "lead@example.org",
        phone: "415-555-0101",
      },
    }),
    site("s2", {
      siteType: "drop_in",
      providerId: "v2",
      leadProgramId: "p2",
      oversight: {
        managingCityDepartment: "Other Department",
        cityProgramManagerId: "pm2",
      },
      location: null,
    }),
    // Closed on the snapshot's day, so it still owes Checks in every period.
    site("s3", { status: "inactive", updatedAt: "2026-11-04T18:00:00.000Z" }),
  ];
  return {
    tasks: /** @type {any[]} */ (tasks),
    conditions: [],
    updates,
    links: [],
    overrides: [],
    checks,
    sites,
    // Every Site owes 3 a day all year, so tests change only what they test.
    terms: sites.map((s) => ({
      siteId: s.siteId,
      termsVersionId: `v-${s.siteId}`,
      effectiveStart: "2026-01-01",
      requiredChecksPerDay: 3,
      status: "active",
    })),
    asOf: TEST_AS_OF,
  };
}

/**
 * Writes the projection's files, as the build job does.
 * @param {any} conn
 * @param {string} dir
 */
export function writeSyntheticProjection(conn, dir) {
  return buildProjection(conn, dir, {
    evaluatedAt: TEST_EVALUATED_AT,
    snapshotId: "snap1",
    inputs: syntheticInputs(),
  });
}

// Built once at import, since each build starts DuckDB.
const built = await buildFromRows(
  syntheticInputs(),
  TEST_EVALUATED_AT,
  "snap1",
);

/** @returns {typeof built} the rows a reader gets back */
export function syntheticProjection() {
  // A copy, so a test that edits its rows can't change another test's.
  return JSON.parse(JSON.stringify(built));
}
