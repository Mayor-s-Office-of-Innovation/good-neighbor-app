import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { sqlString, toRow, writeEntityParquet } from "../analytics/convert.js";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import { buildProjection } from "./projection.js";
import { buildFromRows, readProjection } from "./test-build.js";

const EVALUATED = "2026-10-20T00:00:00.000Z";
const SITE = "SITE#s1";

/** @type {any} */
let instance;
/** @type {any} */
let conn;
/** @type {string} */
let dir;

beforeEach(async () => {
  instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  await conn.run("SET memory_limit = '1GB'");
  dir = mkdtempSync(join(tmpdir(), "insights-projection-"));
});

afterEach(() => {
  conn.closeSync();
  instance.closeSync();
  rmSync(dir, { recursive: true, force: true });
});

/** Stored like the app does, so the tests read the same key shapes. */
const items = [
  {
    pk: SITE,
    sk: "#META",
    siteId: "s1",
    name: "Synthetic Site",
    status: "active",
    publicContact: { email: "desk@example.org", phone: "415-555-0100" },
    location: { latitude: 37.77, longitude: -122.42 },
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    pk: SITE,
    sk: "CHECK#c1",
    checkId: "c1",
    status: "completed",
    flowType: "perimeter",
    startedAt: "2026-10-01T16:00:00.000Z",
    completedAt: "2026-10-01T16:10:00.000Z",
  },
  {
    pk: SITE,
    sk: "TASK#t1",
    taskId: "t1",
    checkId: "c1",
    assessmentId: "a1",
    conditionId: "k1",
    status: "open",
    severity: 4,
    createdAt: "2026-10-01T16:10:00.000Z",
    updatedAt: "2026-10-01T16:10:00.000Z",
  },
  {
    pk: SITE,
    sk: "ASSESSMENT#a1#COND#k1",
    assessmentId: "a1",
    conditionId: "k1",
    taskIds: ["t1"],
    createdAt: "2026-10-01T16:10:00.000Z",
  },
  // Rows a loose classifier once read as more Checks or Issues.
  {
    pk: SITE,
    sk: "TASK#t1#UPDATE_ID#u1",
    taskId: "t1",
    updateId: "u1",
    createdAt: "2026-10-02T00:00:00.000Z",
  },
  {
    pk: SITE,
    sk: "TASK#t1#MEDIA#p1",
    taskId: "t1",
    createdAt: "2026-10-02T00:00:00.000Z",
  },
  {
    pk: SITE,
    sk: "CHECK#c1#UPDATE_MEDIA#p1",
    checkId: "c1",
    startedAt: "2026-10-02T00:00:00.000Z",
  },
  {
    pk: SITE,
    sk: "TASK#t1#UPDATE#2026-10-02T00:00:00.000Z#u1",
    taskId: "t1",
    updateId: "u1",
    type: "escalation_action_taken",
    occurredAt: "2026-10-02T00:00:00.000Z",
  },
];

/**
 * @param {string} [evaluatedAt]
 * @returns {Promise<{ tables: Record<string, Record<string, any>[]>, manifest: Record<string, any> }>}
 */
async function build(evaluatedAt = EVALUATED) {
  const out = join(dir, "projection");
  const { manifest } = await buildProjection(conn, out, {
    evaluatedAt,
    snapshotId: "snap1",
  });
  return { tables: await readProjection(conn, out), manifest };
}

describe("buildProjection over a lake written like an export", () => {
  it("counts one Check and one Issue despite update, media and pointer rows", async () => {
    await writeLocalLake(conn, dir, items, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    // Older exports filed child rows under the parent's entity; the
    // projection must still not count them.
    /** @type {[string, Record<string, any>][]} */
    const oldRows = [
      ["tasks", items[4]],
      ["tasks", items[5]],
      ["checks", items[6]],
    ];
    for (const [entity, child] of oldRows) {
      const partition = join(dir, entity, "date=2026-10-02");
      mkdirSync(partition, { recursive: true });
      await writeEntityParquet(
        conn,
        entity,
        [toRow(entity, child, "2026-10-01T18:00:00.000Z")],
        join(partition, `part-old-${child.sk.replace(/\W/g, "")}.parquet`),
      );
    }
    await createLocalViews(conn, dir);
    const { tables } = await build();
    expect(tables.site_days).toEqual([
      {
        siteId: "s1",
        day: "2026-10-01",
        completedPerimeterChecks: 1,
        singleIssueReports: 0,
        unfinishedChecks: 0,
        issuesCreated: 1,
        severeIssues: 1,
        awaiting: 0,
        overdue: 0,
        onTime: 1,
        late: 0,
        unknown: 0,
        notTimed: 0,
      },
    ]);
    expect(
      tables.issues.map((i) => [i.issueId, i.firstResponseAt, i.responseBasis]),
    ).toEqual([["t1", "2026-10-02T00:00:00.000Z", "timeline"]]);
    expect(
      tables.checks.map((c) => [c.checkId, c.state, c.day, c.issues]),
    ).toEqual([["c1", "completed", "2026-10-01", 1]]);
  });

  it("times each Issue by the window its rule stored on the task", async () => {
    // Answered 7 h 50 min after creation: late against the stored 4 hours,
    // on time against LITTER-1's current 48.
    const ruled = items.map((i) =>
      i.sk === "TASK#t1"
        ? { ...i, ruleId: "LITTER-1", maxAcceptableResponseHours: 4 }
        : i,
    );
    await writeLocalLake(conn, dir, ruled, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    const { tables } = await build();
    expect(tables.issues[0]).toMatchObject({
      deadlineAt: "2026-10-01T20:10:00.000Z",
      responseState: "late",
    });
  });

  it.each([
    [
      "a creation time without seconds",
      { sk: "TASK#t1", createdAt: "2026-10-01T16:10Z" },
      {
        createdAt: "2026-10-01T16:10Z",
        deadlineAt: "2026-10-04T16:10:00.000Z",
      },
    ],
    [
      "a response time with a lowercase z",
      {
        sk: "TASK#t1#UPDATE#2026-10-02T00:00:00.000Z#u1",
        occurredAt: "2026-10-02T00:00:00.000z",
      },
      { firstResponseAt: "2026-10-02T00:00:00.000Z" },
    ],
  ])("reads %s, as Date.parse does", async (_name, change, expected) => {
    const changed = items.map((i) =>
      i.sk === change.sk ? { ...i, ...change } : i,
    );
    await writeLocalLake(conn, dir, changed, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    const { tables } = await build();
    expect(tables.issues).toHaveLength(1);
    expect(tables.issues[0]).toMatchObject(expected);
  });

  it("reads a fractional severity as unknown, as the in-memory path does", async () => {
    const changed = items.map((i) =>
      i.sk === "TASK#t1" ? { ...i, severity: 4.5 } : i,
    );
    await writeLocalLake(conn, dir, changed, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    const { tables } = await build();
    expect(tables.issues[0]).toMatchObject({
      severity: null,
      severityBand: "unknown",
    });
  });

  it("reads task times, IDs and condition order from the raw item", async () => {
    const at = (/** @type {string} */ time) => `2026-10-${time}:00.000Z`;
    const task = {
      pk: SITE,
      checkId: "c1",
      assessmentId: "a1",
      conditionId: "k1",
      severity: 2,
    };
    await writeLocalLake(
      conn,
      dir,
      [
        ...items.slice(0, 2),
        // The condition lists t2 first, so t2 leads though t1 is older.
        {
          pk: SITE,
          sk: "ASSESSMENT#a1#COND#k1",
          assessmentId: "a1",
          conditionId: "k1",
          taskIds: ["t2", "t1"],
          createdAt: at("01T16:10"),
        },
        // A follow-up task completed first, so its completion is the response.
        {
          ...task,
          sk: "TASK#t1",
          taskId: "t1",
          status: "completed",
          createdAt: at("01T16:10"),
          completedAt: at("01T17:00"),
          updatedAt: at("01T17:00"),
        },
        // Closed, then reopened; its last edit is the latest activity.
        {
          ...task,
          sk: "TASK#t2",
          taskId: "t2",
          status: "in_progress",
          createdAt: at("01T16:20"),
          updatedAt: at("05T00:00"),
        },
        {
          pk: SITE,
          sk: "TASK#t2#UPDATE#2026-10-02T00:00:00.000Z#u1",
          taskId: "t2",
          updateId: "u1",
          type: "task_completed",
          occurredAt: at("02T00:00"),
        },
        // A second sighting, linked to the follow-up task.
        {
          pk: SITE,
          sk: "TASK#t3",
          taskId: "t3",
          checkId: "c1",
          status: "open",
          createdAt: at("01T16:30"),
        },
        {
          pk: SITE,
          sk: "DUP_LINK#t3",
          taskId: "t3",
          originalTaskId: "t1",
          occurredAt: at("01T16:30"),
        },
        // Started with no timeline event, so only inProgressAt times it.
        {
          ...task,
          sk: "TASK#t4",
          taskId: "t4",
          conditionId: "k2",
          status: "in_progress",
          createdAt: at("03T00:00"),
          inProgressAt: at("03T02:00"),
        },
      ],
      { exportedAt: "2026-10-19T18:00:00.000Z", exportId: "e1" },
    );
    await createLocalViews(conn, dir);
    const { tables } = await build();
    expect(
      tables.issues.map((i) => [
        i.issueId,
        i.checkId,
        i.source,
        i.firstResponseAt,
        i.latestActivityAt,
        i.reopened,
        i.sightings,
        i.followUpTasks,
      ]),
    ).toEqual([
      ["t2", "c1", "perimeter", at("01T17:00"), at("05T00:00"), true, 2, 1],
      ["t4", "c1", "perimeter", at("03T02:00"), at("03T02:00"), false, 1, 0],
    ]);
  });

  it("orders Sites by the bytes of their IDs, like the other tables", async () => {
    const { tables } = await buildFromRows(
      { sites: [{ siteId: "b" }, { siteId: "B" }, { siteId: "a" }] },
      EVALUATED,
    );
    expect(tables.sites.map((s) => s.siteId)).toEqual(["B", "a", "b"]);
    expect(tables.site_contacts.map((s) => s.siteId)).toEqual(["B", "a", "b"]);
  });

  it("leaves no temp tables or macros on the connection", async () => {
    const leftovers = async () =>
      (
        await conn.runAndReadAll(
          `SELECT (SELECT count(*)::INTEGER FROM duckdb_tables() WHERE temporary),
             (SELECT count(*)::INTEGER FROM duckdb_functions() WHERE function_name = 'snapshot_at')`,
        )
      ).getRowsJS()[0];
    await writeLocalLake(conn, dir, items, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    await build();
    expect(await leftovers()).toEqual([0, 0]);
    // A build that fails part-way cleans up too.
    await expect(build("2026-10-19T17:59:59.999Z")).rejects.toThrow(
      "latest export",
    );
    expect(await leftovers()).toEqual([0, 0]);
  });

  it("describes each Site and says when the data is from", async () => {
    await writeLocalLake(conn, dir, items, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    const { tables, manifest } = await build();
    expect(tables.sites[0]).toMatchObject({ siteId: "s1", hasLocation: true });
    expect(tables.site_contacts[0]).toMatchObject({
      publicContact: "available",
      siteContact: "missing",
      basis: "current",
    });
    expect(manifest).toMatchObject({
      asOf: "2026-10-19T18:00:00.000Z",
      evaluatedAt: EVALUATED,
    });
  });

  it("uses a task's latest export, so a replaced task drops out", async () => {
    await writeLocalLake(conn, dir, items, {
      exportedAt: "2026-10-19T12:00:00.000Z",
      exportId: "e1",
    });
    await writeLocalLake(
      conn,
      dir,
      [
        {
          ...items[2],
          status: "superseded",
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
        {
          ...items[2],
          sk: "TASK#t2",
          taskId: "t2",
          assessmentId: "a2",
          createdAt: "2026-10-03T00:00:00.000Z",
        },
        {
          pk: SITE,
          sk: "ASSESSMENT#a1",
          assessmentId: "a1",
          supersededByAssessmentId: "a2",
          reportedAt: "2026-10-01T16:10:00.000Z",
        },
      ],
      { exportedAt: "2026-10-19T18:00:00.000Z", exportId: "e2" },
    );
    await createLocalViews(conn, dir);
    const { tables, manifest } = await build();
    expect(tables.issues.map((i) => i.issueId)).toEqual(["t2"]);
    expect(manifest.dataQuality.superseded).toBe(1);
  });

  it("keeps a task the app kept when it replaced the assessment", async () => {
    await writeLocalLake(
      conn,
      dir,
      [
        ...items,
        { ...items[2], sk: "TASK#t2", taskId: "t2", assessmentId: "a2" },
        {
          pk: SITE,
          sk: "ASSESSMENT#a1",
          assessmentId: "a1",
          supersededByAssessmentId: "a2",
          reportedAt: "2026-10-01T16:10:00.000Z",
        },
      ],
      { exportedAt: "2026-10-19T18:00:00.000Z", exportId: "e1" },
    );
    await createLocalViews(conn, dir);
    const { tables } = await build();
    // The app keeps tasks of unchanged conditions and ones staff acted on.
    expect(tables.issues.map((i) => i.issueId)).toEqual(["t1", "t2"]);
  });

  it("leads each Issue with the task its condition lists first", async () => {
    /** @type {Record<string, any>[]} */
    const listed = items.map((i) =>
      i.sk === "ASSESSMENT#a1#COND#k1" ? { ...i, taskIds: ["t2", "t1"] } : i,
    );
    listed.push({
      ...items[2],
      sk: "TASK#t2",
      taskId: "t2",
      createdAt: "2026-10-01T17:00:00.000Z",
    });
    await writeLocalLake(conn, dir, listed, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    const { tables } = await build();
    expect(
      tables.issues.map((i) => [i.issueId, i.createdAt, i.followUpTasks]),
    ).toEqual([["t2", "2026-10-01T17:00:00.000Z", 1]]);
  });

  it("replaces the previous projection whole", async () => {
    await writeLocalLake(conn, dir, items, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    const out = join(dir, "projection");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "stale.parquet"), "");
    await build();
    expect(readdirSync(out).sort()).toEqual([
      "checks.parquet",
      "issues.parquet",
      "manifest.json",
      "site_contacts.parquet",
      "site_days.parquet",
      "sites.parquet",
    ]);
  });

  it("refuses a snapshot time it can't read", async () => {
    await createLocalViews(conn, dir);
    await expect(build("soon")).rejects.toThrow("valid evaluatedAt");
  });

  it("refuses a snapshot time before the latest export", async () => {
    await writeLocalLake(conn, dir, items, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, dir);
    await expect(build("2026-10-19T17:59:59.999Z")).rejects.toThrow(
      "latest export",
    );
  });

  it("builds an empty view for a folder with no Parquet files", async () => {
    mkdirSync(join(dir, "tasks", "date=2026-10-01"), { recursive: true });
    writeFileSync(join(dir, "tasks", ".DS_Store"), "");
    writeFileSync(join(dir, "tasks", "date=2026-10-01", "left.ndjson"), "");
    await createLocalViews(conn, dir);
    const reader = await conn.runAndReadAll(
      "SELECT count(*)::INTEGER FROM tasks",
    );
    expect(reader.getRowsJS()).toEqual([[0]]);
  });

  it("writes each empty table as a typed file with no rows", async () => {
    await createLocalViews(conn, dir);
    const out = join(dir, "o'neil", "projection");
    await buildProjection(conn, out, {
      evaluatedAt: EVALUATED,
      snapshotId: "empty",
    });
    /** @type {[string, string][]} */
    const probes = [
      ["site_days", "typeof(any_value(day)), typeof(any_value(awaiting))"],
      ["issues", "typeof(any_value(createdDay)), typeof(any_value(reopened))"],
      ["site_contacts", "typeof(any_value(basis)), 'n/a'"],
      ["sites", "typeof(any_value(hasLocation)), 'n/a'"],
      ["checks", "typeof(any_value(day)), typeof(any_value(issues))"],
    ];
    const found = [];
    for (const [name, types] of probes) {
      const reader = await conn.runAndReadAll(
        `SELECT count(*)::INTEGER, ${types} FROM ${sqlString(join(out, `${name}.parquet`))}`,
      );
      found.push(reader.getRowsJS()[0]);
    }
    expect(found).toEqual([
      [0, "DATE", "INTEGER"],
      [0, "DATE", "BOOLEAN"],
      [0, "VARCHAR", "n/a"],
      [0, "BOOLEAN", "n/a"],
      [0, "DATE", "INTEGER"],
    ]);
  });

  it("writes Parquet tables a reader gets the same totals back from", async () => {
    // A checkout path with an apostrophe must not break the SQL.
    const lake = join(dir, "o'neil");
    await writeLocalLake(conn, lake, items, {
      exportedAt: "2026-10-19T18:00:00.000Z",
      exportId: "e1",
    });
    await createLocalViews(conn, lake);
    const out = join(lake, "projection");
    const { written } = await buildProjection(conn, out, {
      evaluatedAt: EVALUATED,
      snapshotId: "snap1",
    });
    expect(written).toEqual([
      "site_days.parquet",
      "issues.parquet",
      "site_contacts.parquet",
      "sites.parquet",
      "checks.parquet",
      "manifest.json",
    ]);
    const reader = await conn.runAndReadAll(
      `SELECT sum(completedPerimeterChecks)::INTEGER, sum(issuesCreated)::INTEGER, typeof(any_value(day)) FROM ${sqlString(join(out, "site_days.parquet"))}`,
    );
    expect(reader.getRowsJS()).toEqual([[1, 1, "DATE"]]);
  });
});
