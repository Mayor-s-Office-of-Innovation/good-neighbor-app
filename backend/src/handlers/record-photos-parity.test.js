// The photo panel walks the live table while Insights' Issue list runs SQL on
// the snapshot, so these cases run both on the same tasks and compare.

import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({
  getDynamoTableName: () => "table",
  getConfig: () => ({ uploadBucket: "bucket" }),
}));
vi.mock("../s3.js", () => ({
  presignGet: vi.fn(async () => "https://x.test"),
}));
import { getRecordPhotos } from "./record-photos.js";
import { RULES_SQL, snapshotMacrosSql } from "../reporting/projection-sql.js";

const EVALUATED_AT = "2026-10-10T00:00:00.000Z";
// The rules up to Issue membership; later rules need inputs these cases lack.
const MEMBERS_SQL = RULES_SQL.slice(
  0,
  RULES_SQL.indexOf(";", RULES_SQL.indexOf("TEMP TABLE issue_members")) + 1,
);

/**
 * @typedef {{ tasks: [string, string, string?][], conditions?: Record<string, string[]>,
 *   links?: [string, string][], separated?: string[] }} Case
 */

/**
 * @param {Case[]} cases each on its own Site, so one DuckDB run serves them all
 * @returns {Promise<Map<string, string[]>[]>} each case's Issues' live tasks, by Issue
 */
async function sqlIssues(cases) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  /**
   * @param {string} name
   * @param {Record<string, string>} schema
   * @param {Record<string, unknown>[]} list
   */
  const load = (name, schema, list) =>
    conn.run(
      `CREATE TEMP TABLE ${name} AS SELECT unnest(from_json($1::JSON, '${JSON.stringify([schema])}'), recursive := true)`,
      [JSON.stringify(list)],
    );
  const V = "VARCHAR";
  try {
    await load(
      "in_tasks",
      {
        siteId: V,
        taskId: V,
        status: V,
        createdAt: V,
        assessmentId: V,
        conditionId: V,
      },
      cases.flatMap((c, site) =>
        c.tasks.map(([taskId, status, conditionId], i) => ({
          siteId: `s${site}`,
          taskId,
          status,
          createdAt: new Date(
            Date.parse("2026-10-01") + i * 60000,
          ).toISOString(),
          assessmentId: conditionId ? "a1" : null,
          conditionId: conditionId ?? null,
        })),
      ),
    );
    await load(
      "in_conditions",
      { siteId: V, assessmentId: V, conditionId: V, taskIds: "VARCHAR[]" },
      cases.flatMap((c, site) =>
        Object.entries(c.conditions ?? {}).map(([conditionId, taskIds]) => ({
          siteId: `s${site}`,
          assessmentId: "a1",
          conditionId,
          taskIds,
        })),
      ),
    );
    await load(
      "in_links",
      { siteId: V, taskId: V, originalTaskId: V },
      cases.flatMap((c, site) =>
        (c.links ?? []).map(([taskId, originalTaskId]) => ({
          siteId: `s${site}`,
          taskId,
          originalTaskId,
        })),
      ),
    );
    await load(
      "in_overrides",
      { siteId: V, taskId: V },
      cases.flatMap((c, site) =>
        (c.separated ?? []).map((taskId) => ({ siteId: `s${site}`, taskId })),
      ),
    );
    await conn.run(snapshotMacrosSql(EVALUATED_AT));
    await conn.run(MEMBERS_SQL);
    const reader = await conn.runAndReadAll(
      "SELECT siteId, rootId, list_sort(list(taskId)) AS ids FROM issue_members GROUP BY ALL ORDER BY siteId, rootId",
    );
    const issues = cases.map(() => new Map());
    for (const r of reader.getRowObjectsJS())
      issues[Number(String(r.siteId).slice(1))].set(
        String(r.rootId),
        /** @type {string[]} */ (r.ids).map(String).sort(),
      );
    return issues;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * Serves the case as live-table rows; each task's note is its own ID, so the
 * panel's notes name the tasks it walked to.
 * @param {Case} c
 */
function serve(c) {
  /** @type {Record<string, any>[]} */
  const rows = [];
  for (const [taskId, status, conditionId] of c.tasks) {
    rows.push({
      sk: `TASK#${taskId}`,
      taskId,
      checkId: "c1",
      status,
      ...(conditionId ? { assessmentId: "a1", conditionId } : {}),
    });
    rows.push({
      sk: `TASK#${taskId}#UPDATE#2026-10-09T17:00:00.000Z#u1`,
      notes: [taskId],
      occurredAt: "2026-10-09T17:00:00.000Z",
    });
  }
  for (const [conditionId, taskIds] of Object.entries(c.conditions ?? {}))
    rows.push({ sk: `ASSESSMENT#a1#COND#${conditionId}`, taskIds });
  for (const [taskId, originalTaskId] of c.links ?? [])
    rows.push({ sk: `DUP_LINK#${taskId}`, taskId, originalTaskId });
  for (const taskId of c.separated ?? [])
    rows.push({ sk: `DUP_OVERRIDE#${taskId}`, taskId });
  send.mockReset();
  send.mockImplementation(async (/** @type {any} */ command) => {
    const input = command.input;
    if (input.Key) return { Item: rows.find((r) => r.sk === input.Key.sk) };
    const prefix = input.ExpressionAttributeValues[":prefix"];
    return { Items: rows.filter((r) => r.sk.startsWith(prefix)) };
  });
}

/**
 * @param {string} issueId
 * @returns {Promise<string[]>}
 */
async function panelTasks(issueId) {
  const res = /** @type {any} */ (
    await getRecordPhotos(
      /** @type {any} */ ({
        requestContext: {
          authorizer: {
            jwt: { claims: { "cognito:groups": "compliance-supervisor" } },
          },
        },
        pathParameters: { siteId: "s1" },
        queryStringParameters: { issueId },
      }),
      /** @type {any} */ ({}),
      () => {},
    )
  );
  return JSON.parse(res.body)
    .notes.map((/** @type {{ text: string }} */ n) => n.text)
    .sort();
}

/** @type {[string, Case][]} */
const CASES = [
  [
    "an Issue whose first task links on to a replaced task with no link",
    {
      tasks: [
        ["t0", "superseded"],
        ["t1", "open"],
        ["t2", "open"],
      ],
      links: [
        ["t1", "t0"],
        ["t2", "t1"],
      ],
    },
  ],
  [
    "a chain back to that first task through replaced sightings on its condition",
    {
      tasks: [
        ["t0", "superseded"],
        ["t1", "open", "k1"],
        ["t3", "superseded"],
        ["t4", "superseded", "k1"],
        ["t5", "open"],
      ],
      conditions: { k1: ["t1", "t4"] },
      links: [
        ["t1", "t0"],
        ["t3", "t1"],
        ["t4", "t3"],
        ["t5", "t4"],
      ],
    },
  ],
  [
    "two tasks linked to each other",
    {
      tasks: [
        ["t1", "open"],
        ["t2", "open"],
      ],
      links: [
        ["t1", "t2"],
        ["t2", "t1"],
      ],
    },
  ],
  [
    "a duplicate linked through a replaced sighting",
    {
      tasks: [
        ["t1", "open"],
        ["t8", "superseded"],
        ["t9", "open"],
      ],
      links: [
        ["t8", "t1"],
        ["t9", "t8"],
      ],
    },
  ],
  [
    "a duplicate of a replaced sighting that links nowhere",
    {
      tasks: [
        ["t1", "open", "k1"],
        ["t8", "superseded", "k1"],
        ["t9", "open"],
      ],
      conditions: { k1: ["t1", "t8"] },
      links: [["t9", "t8"]],
    },
  ],
  [
    "a replaced sighting whose original joins a wave later",
    {
      tasks: [
        ["t1", "open", "k1"],
        ["t4", "open", "k1"],
        ["t6", "open"],
        ["t8", "superseded", "k1"],
        ["t9", "open"],
      ],
      conditions: { k1: ["t1", "t4", "t8"] },
      links: [
        ["t6", "t4"],
        ["t8", "t6"],
        ["t9", "t8"],
      ],
    },
  ],
  [
    "two replaced sightings in a row",
    {
      tasks: [
        ["t1", "open", "k1"],
        ["t4", "open", "k1"],
        ["t10", "superseded", "k1"],
        ["t11", "deleted", "k1"],
        ["t12", "open"],
      ],
      conditions: { k1: ["t1", "t4", "t11", "t10"] },
      links: [
        ["t10", "t4"],
        ["t11", "t10"],
        ["t12", "t11"],
      ],
    },
  ],
  [
    "a duplicate staff split back out",
    {
      tasks: [
        ["t1", "open"],
        ["t2", "open"],
      ],
      links: [["t2", "t1"]],
      separated: ["t2"],
    },
  ],
];

/**
 * Seeded, so a failure replays.
 * @param {number} seed
 */
function random(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A Site with replaced sightings, follow-ups, chains, loops, split-out
 * duplicates and links or list entries naming missing tasks, mixed at random;
 * most links point at older tasks, as in the app. Every task is on its
 * condition's list and dated, as the app writes them; the panel finds a
 * condition's tasks through that list.
 * @param {() => number} rand
 * @returns {Case}
 */
function randomCase(rand) {
  const pick = (/** @type {number} */ n) => Math.floor(rand() * n);
  const n = 2 + pick(9);
  /** @type {Case["tasks"]} */
  const tasks = [];
  /** @type {Record<string, string[]>} */
  const conditions = {};
  /** @type {[string, string][]} */
  const links = [];
  /** @type {string[]} */
  const separated = [];
  for (let i = 0; i < n; i++) {
    const roll = rand();
    const status = roll < 0.55 ? "open" : roll < 0.8 ? "superseded" : "deleted";
    const conditionId = rand() < 0.5 ? `k${pick(3)}` : undefined;
    tasks.push([`t${i}`, status, conditionId]);
    if (conditionId) (conditions[conditionId] ??= []).push(`t${i}`);
    const to = rand() < 0.05 ? n + 1 : rand() < 0.08 ? pick(n) : pick(i);
    if (i > 0 && to !== i && rand() < 0.65) {
      links.push([`t${i}`, `t${to}`]);
      if (rand() < 0.08) separated.push(`t${i}`);
    }
  }
  for (const ids of Object.values(conditions)) {
    // A list may name a task that is gone or on another condition.
    if (rand() < 0.1) ids.splice(pick(ids.length + 1), 0, `t${pick(n + 2)}`);
    // The condition's own order, not creation order, picks the first task.
    if (rand() < 0.4) ids.reverse();
  }
  return { tasks, conditions, links, separated };
}

/** @param {Case[]} cases */
async function differences(cases) {
  const issues = await sqlIssues(cases);
  const found = [];
  let compared = 0;
  for (const [i, c] of cases.entries()) {
    serve(c);
    // Asked from any of its tasks, the panel shows the whole Issue.
    for (const [rootId, ids] of issues[i])
      for (const issueId of [rootId, ...ids.filter((id) => id !== rootId)]) {
        compared++;
        const panel = await panelTasks(issueId);
        if (JSON.stringify(panel) !== JSON.stringify(ids))
          found.push({ case: i, issueId, rootId, sql: ids, panel });
      }
  }
  return { compared, found };
}

describe("record photos' Issue walk against the Issue list's SQL", () => {
  it.each(CASES)("gives the same tasks for %s", async (_, c) => {
    const { compared, found } = await differences([c]);
    expect(compared).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  it("gives the same tasks on random Sites", async () => {
    const rand = random(722);
    const cases = Array.from({ length: 1500 }, () => randomCase(rand));
    const { compared, found } = await differences(cases);
    expect(compared).toBeGreaterThan(5000);
    expect({
      differ: found.length,
      of: compared,
      first: found.slice(0, 3),
    }).toEqual({
      differ: 0,
      of: compared,
      first: [],
    });
  });
});
