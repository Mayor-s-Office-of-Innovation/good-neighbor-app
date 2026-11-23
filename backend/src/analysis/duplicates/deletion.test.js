// @ts-nocheck -- in-memory command harness exercises transaction boundaries.
import { beforeEach, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { analysisRevision, projectionKey } from "./jobs.js";
const state = vi.hoisted(() => ({
  rows: new Map(),
  writes: [],
  fail: false,
  before: null,
}));
vi.mock("../../db.js", () => ({
  ddb: {
    send: async ({ input }) => {
      if (input.Key) return { Item: state.rows.get(input.Key.sk) };
      if (input.KeyConditionExpression)
        return {
          Items: [...state.rows.values()].filter((row) =>
            row.sk.startsWith(input.ExpressionAttributeValues[":prefix"]),
          ),
        };
      state.before?.();
      for (const entry of input.TransactItems) {
        const write = entry.Put || entry.Update;
        const guard = entry.ConditionCheck;
        const row = state.rows.get(
          write?.Item?.sk || write?.Key?.sk || guard?.Key.sk,
        );
        let conflict = false;
        if ((write?.Item?.sk || write?.Key?.sk)?.startsWith("TASK#")) {
          const expected = write.ExpressionAttributeValues;
          conflict =
            row.status !== expected[":status"] ||
            row.updatedAt !== expected[":updatedAt"] ||
            (write.ConditionExpression.includes(":groupVersion")
              ? row.duplicateGroupVersion !== expected[":groupVersion"]
              : write.ConditionExpression.includes(
                  "attribute_not_exists(duplicateGroupVersion)",
                ) && row.duplicateGroupVersion !== undefined);
        }
        if (guard?.Key.sk.startsWith("DUP_OVERRIDE#")) conflict = Boolean(row);
        if (guard?.Key.sk.startsWith("DUP_LINK#")) {
          const expected = guard.ExpressionAttributeValues;
          conflict =
            row?.originalTaskId !== expected[":root"] ||
            row?.sourceRevision !== expected[":revision"];
        }
        const expression = write || guard;
        if (
          expression?.ConditionExpression?.includes("attribute_not_exists(sk)")
        )
          conflict ||= Boolean(row);
        if (expression?.ConditionExpression?.includes("attribute_exists(sk)"))
          conflict ||= !row;
        for (const [name, field] of Object.entries(
          expression?.ExpressionAttributeNames || {},
        )) {
          if (!name.startsWith("#proof")) continue;
          const value = `:proof${name.slice(6)}`;
          conflict ||= Object.hasOwn(
            expression.ExpressionAttributeValues || {},
            value,
          )
            ? !isDeepStrictEqual(
                row?.[field],
                expression.ExpressionAttributeValues[value],
              )
            : row?.[field] !== undefined;
        }
        if (conflict)
          throw Object.assign(new Error("concurrent change"), {
            name: "TransactionCanceledException",
          });
      }
      if (state.fail)
        throw Object.assign(new Error("concurrent change"), {
          name: "TransactionCanceledException",
        });
      state.writes.push(input.TransactItems);
      for (const { Put, Update, Delete } of input.TransactItems) {
        if (Delete) state.rows.delete(Delete.Key.sk);
        if (Put) state.rows.set(Put.Item.sk, Put.Item);
        if (Update) {
          const row = { ...state.rows.get(Update.Key.sk) };
          for (const match of Update.UpdateExpression.matchAll(
            /(#[A-Za-z0-9]+) = (:[A-Za-z0-9]+)/g,
          ))
            row[Update.ExpressionAttributeNames[match[1]]] =
              Update.ExpressionAttributeValues[match[2]];
          state.rows.set(Update.Key.sk, row);
        }
      }
      return {};
    },
  },
}));
import { groupForTask } from "./group.js";
import {
  duplicateForTask,
  sharedActionTarget,
  reconcileObservation,
} from "./links.js";
import { deletionScope, deleteTaskGroup } from "./deletion.js";
const task = (id, status = "open") => ({
  pk: "SITE#site",
  sk: `TASK#${id}`,
  taskId: id,
  checkId: `check-${id}`,
  conditionId: `condition-${id}`,
  sourceArtifactIds: [`artifact-${id}`],
  kind: "care",
  status,
  updatedAt: "2026-11-01T12:00:00Z",
});
function put(row) {
  state.rows.set(row.sk, row);
  if (
    row.sk.startsWith("TASK#") &&
    !state.rows.has(`CHECK#${row.checkId}#ANALYSIS#${row.sourceArtifactIds[0]}`)
  ) {
    const artifactId = row.sourceArtifactIds[0];
    const time = new Date(
      Date.parse("2026-11-01T12:00:00Z") + state.rows.size * 60000,
    ).toISOString();
    const analysis = {
      pk: row.pk,
      sk: `CHECK#${row.checkId}#ANALYSIS#${artifactId}`,
      status: "analyzed",
      analysisId: row.taskId,
      generatedAt: time,
      concerns: [
        { conditionId: row.conditionId, category: "Litter", rating: 2 },
      ],
    };
    const records = [
      analysis,
      { pk: row.pk, sk: `CHECK#${row.checkId}#ART#${artifactId}` },
      {
        ...projectionKey("site", time, `${row.checkId}:${artifactId}`),
        revision: analysisRevision(analysis),
      },
      {
        pk: row.pk,
        sk: `GUIDANCE_CURRENT#${JSON.stringify([row.checkId, artifactId])}`,
        assessmentId: row.taskId,
      },
      {
        pk: row.pk,
        sk: `ASSESSMENT#${row.taskId}#COND#${row.conditionId}`,
        taskIds: [row.taskId],
      },
      {
        pk: row.pk,
        sk: `DUP_RESULT#${row.checkId}:${artifactId}#${analysisRevision(analysis)}`,
        status: "evaluated",
        processingState: "complete",
        conditionResults: [
          {
            conditionId: row.conditionId,
            status: "evaluated",
            possibleDuplicate: false,
          },
        ],
      },
    ];
    for (const record of records) state.rows.set(record.sk, record);
  }
  return row;
}
function linked(id, status) {
  const child = put(task(id, status));
  const analysis = state.rows.get(
    `CHECK#${child.checkId}#ANALYSIS#${child.sourceArtifactIds[0]}`,
  );
  const original = state.rows.get("TASK#root");
  const rootAnalysis = state.rows.get(
    `CHECK#${original.checkId}#ANALYSIS#${original.sourceArtifactIds[0]}`,
  );
  const revision = analysisRevision(analysis);
  put({
    pk: child.pk,
    sk: `DUP_ISSUE#${child.checkId}:${child.sourceArtifactIds[0]}#${revision}#${child.conditionId}`,
    possibleDuplicate: true,
    matchStrength: "strong",
    duplicateOf: {
      observationId: `${original.checkId}:${original.sourceArtifactIds[0]}`,
      conditionId: original.conditionId,
      revision: analysisRevision(rootAnalysis),
    },
    updatedAt: analysis.generatedAt,
  });
  put({
    pk: "SITE#site",
    sk: `DUP_LINK#${id}`,
    taskId: id,
    originalTaskId: "root",
    sourceRevision: revision,
  });
}
function input(
  id,
  expectedTaskIds = [...state.rows.values()]
    .filter((row) => row.sk.startsWith("TASK#"))
    .map((row) => row.taskId),
) {
  return {
    taskId: id,
    checkId: `check-${id}`,
    artifactId: `artifact-${id}`,
    conditionId: `condition-${id}`,
    expectedTaskIds,
  };
}
beforeEach(() => {
  state.rows.clear();
  state.writes = [];
  state.fail = false;
  state.before = null;
});
it("commits silent cancellation work atomically with selected deletion", async () => {
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "true");
  try {
    const row = task("solo", "in_progress");
    row.appActions = [
      {
        code: "create_311_ticket",
        payload: { executionTrigger: "task_created" },
      },
    ];
    put(row);
    await deleteTaskGroup("table", "site", {
      ...input("solo", ["solo"]),
      mode: "selected",
    });
    const transaction = state.writes.find((entries) =>
      entries.some((entry) => entry.Put?.Item?.entityType === "SF311_OUTBOX"),
    );
    expect(transaction).toBeDefined();
    expect(
      transaction.some((entry) => entry.Update?.Key?.sk === "TASK#solo"),
    ).toBe(true);
    expect(state.rows.get("SF311_JOB#solo#deleted")?.status).toBe("pending");
  } finally {
    vi.unstubAllEnvs();
  }
});
it.each([undefined, [], [""], ["root", "root"], [12]])(
  "rejects an unconfirmed deletion scope %j without writing",
  async (expectedTaskIds) => {
    put(task("root"));
    linked("one");
    await expect(
      deleteTaskGroup("table", "site", { ...input("root"), expectedTaskIds }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(state.writes).toHaveLength(0);
    expect(state.rows.get("TASK#one").status).toBe("open");
  },
);
it("deletes a standalone card atomically and replays the same receipt", async () => {
  put(task("solo"));
  const deleted = await deleteTaskGroup(
    "table",
    "site",
    input("solo", ["solo"]),
  );
  expect(deleted.map((row) => row.taskId)).toEqual(["solo"]);
  expect(state.rows.get("TASK#solo").status).toBe("superseded");
  expect(
    await deleteTaskGroup("table", "site", input("solo", ["solo"])),
  ).toEqual(deleted);
  expect(
    await deleteTaskGroup("table", "site", {
      ...input("solo"),
      expectedTaskIds: undefined,
    }),
  ).toEqual(deleted);
  expect(state.writes).toHaveLength(1);
});
it("deletes only the clicked duplicate, leaving the original and siblings intact", async () => {
  put(task("root"));
  linked("one");
  linked("two");
  expect((await deletionScope("table", "site", task("one"))).kind).toBe(
    "duplicate",
  );
  await deleteTaskGroup("table", "site", input("one", ["one"]));
  expect(state.rows.get("TASK#one").status).toBe("superseded");
  expect(state.rows.get("TASK#root").status).toBe("open");
  expect(state.rows.get("TASK#two").status).toBe("open");
});
it("deletes a root across all tabs, excluding separated and unrelated cards", async () => {
  put(task("root"));
  linked("todo");
  linked("progress", "in_progress");
  linked("history", "completed");
  linked("separated");
  put({
    pk: "SITE#site",
    sk: 'DUP_OVERRIDE#["check-separated","artifact-separated","condition-separated"]',
    taskId: "separated",
  });
  put(task("unrelated"));
  const ids = ["root", "todo", "progress", "history"];
  const result = await deleteTaskGroup("table", "site", input("root", ids));
  expect(result.map((row) => row.taskId).sort()).toEqual(ids.sort());
  for (const id of ids)
    expect(state.rows.get(`TASK#${id}`).status).toBe("superseded");
  expect(state.rows.get("TASK#separated").status).toBe("open");
  expect(state.rows.get("TASK#unrelated").status).toBe("open");
  const guards = state.writes[0].filter((row) => row.ConditionCheck);
  expect(
    guards.some((entry) =>
      entry.ConditionCheck.Key.sk.startsWith("DUP_RESULT#"),
    ),
  ).toBe(true);
});
it("rejects a changed confirmation scope and mismatched evidence before writing", async () => {
  put(task("root"));
  linked("new");
  await expect(
    deleteTaskGroup("table", "site", input("root", ["root"])),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    deleteTaskGroup("table", "site", {
      ...input("root"),
      checkId: "other-site-check",
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.writes).toHaveLength(0);
});
it("leaves the entire group intact when its transaction fails", async () => {
  put(task("root"));
  linked("one");
  state.fail = true;
  await expect(
    deleteTaskGroup("table", "site", input("root")),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.rows.get("TASK#root").status).toBe("open");
  expect(state.rows.get("TASK#one").status).toBe("open");
  expect(
    [...state.rows.keys()].some((key) => key.startsWith("ISSUE_DELETION#")),
  ).toBe(false);
});
it("rejects oversized groups before any write", async () => {
  put(task("root"));
  for (let i = 0; i < 30; i++) linked(`member-${i}`);
  await expect(
    deleteTaskGroup("table", "site", input("root")),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.writes).toHaveLength(0);
});

it("cancels when another duplicate joins after the membership read", async () => {
  put({ ...task("root"), duplicateGroupVersion: "before" });
  linked("one");
  state.before = () =>
    put({ ...state.rows.get("TASK#root"), duplicateGroupVersion: "after" });
  await expect(
    deleteTaskGroup("table", "site", input("root")),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.rows.get("TASK#root").status).toBe("open");
  expect(state.rows.get("TASK#one").status).toBe("open");
});
it("cancels when a member is separated after confirmation", async () => {
  put(task("root"));
  linked("one");
  state.before = () =>
    put({
      pk: "SITE#site",
      sk: 'DUP_OVERRIDE#["check-one","artifact-one","condition-one"]',
      taskId: "one",
    });
  await expect(
    deleteTaskGroup("table", "site", input("root")),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.rows.get("TASK#root").status).toBe("open");
  expect(state.rows.get("TASK#one").status).toBe("open");
});

it("includes indirect duplicates when deleting the root", async () => {
  put(task("root"));
  linked("middle");
  linked("leaf", "completed");
  put({ ...state.rows.get("DUP_LINK#leaf"), originalTaskId: "middle" });
  const deleted = await deleteTaskGroup(
    "table",
    "site",
    input("root", ["root", "middle", "leaf"]),
  );
  expect(deleted.map((row) => row.taskId).sort()).toEqual([
    "leaf",
    "middle",
    "root",
  ]);
  expect(state.rows.get("TASK#leaf").status).toBe("superseded");
});

it("excludes a former duplicate after its current result becomes a non-match", async () => {
  put(task("root"));
  linked("independent");
  const incremental = [...state.rows.keys()].find((key) =>
    key.startsWith("DUP_ISSUE#"),
  );
  state.rows.delete(incremental);
  const { duplicateForTask } = await import("./links.js");
  expect(
    (
      await duplicateForTask(
        "table",
        "site",
        state.rows.get("TASK#independent"),
      )
    ).state,
  ).toBe("complete");
  expect(
    (await deletionScope("table", "site", task("root"))).targets.map(
      (row) => row.taskId,
    ),
  ).toEqual(["root"]);
  await deleteTaskGroup("table", "site", input("root", ["root"]));
  expect(state.rows.get("TASK#independent").status).toBe("open");
});
it("confirms a former duplicate as a single card without touching its old original", async () => {
  put(task("root"));
  linked("independent");
  state.rows.delete(
    [...state.rows.keys()].find((key) => key.startsWith("DUP_ISSUE#")),
  );
  expect((await deletionScope("table", "site", task("independent"))).kind).toBe(
    "single",
  );
  await deleteTaskGroup("table", "site", input("independent", ["independent"]));
  expect(state.rows.get("TASK#root").status).toBe("open");
});
it("cancels the entire deletion if evidence is invalidated after validation", async () => {
  put(task("root"));
  linked("one");
  const key = [...state.rows.keys()].find((key) =>
    key.startsWith("DUP_RESULT#check-one:"),
  );
  state.before = () =>
    put({ ...state.rows.get(key), invalidatedAt: "2026-11-02T12:00:00Z" });
  await expect(
    deleteTaskGroup("table", "site", input("root")),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.rows.get("TASK#root").status).toBe("open");
  expect(state.rows.get("TASK#one").status).toBe("open");
});
it("preserves concurrent background 311 results during deletion", async () => {
  put(task("root"));
  linked("one");
  const results = [
    {
      code: "create_311_ticket",
      status: "submitted",
      payload: { tickets: [{ srNum: "synthetic-ticket" }] },
    },
  ];
  state.before = () =>
    put({
      ...state.rows.get("TASK#root"),
      appActionResults: results,
      appActionStatus: "submitted",
    });
  await deleteTaskGroup("table", "site", input("root"));
  expect(state.rows.get("TASK#root")).toMatchObject({
    status: "superseded",
    appActionResults: results,
    appActionStatus: "submitted",
  });
});
it("does not let a cycle in another component block a standalone card", async () => {
  put(task("solo"));
  put({ pk: "SITE#site", sk: "DUP_LINK#x", taskId: "x", originalTaskId: "y" });
  put({ pk: "SITE#site", sk: "DUP_LINK#y", taskId: "y", originalTaskId: "x" });
  expect((await deletionScope("table", "site", task("solo"))).kind).toBe(
    "single",
  );
  await deleteTaskGroup("table", "site", input("solo", ["solo"]));
  expect(state.rows.get("TASK#solo").status).toBe("superseded");
});
it("still rejects a cycle involving the selected card", async () => {
  put(task("x"));
  put(task("y"));
  put({ pk: "SITE#site", sk: "DUP_LINK#x", taskId: "x", originalTaskId: "y" });
  put({ pk: "SITE#site", sk: "DUP_LINK#y", taskId: "y", originalTaskId: "x" });
  await expect(deletionScope("table", "site", task("x"))).rejects.toMatchObject(
    { statusCode: 409 },
  );
});
it("waits for unsettled evidence instead of silently partially deleting a group", async () => {
  put(task("root"));
  linked("one");
  state.rows.delete(
    [...state.rows.keys()].find((key) => key.startsWith("DUP_ISSUE#")),
  );
  const key = [...state.rows.keys()].find((key) =>
    key.startsWith("DUP_RESULT#check-one:"),
  );
  put({
    ...state.rows.get(key),
    status: "pending",
    processingState: "pending",
    conditionResults: [],
  });
  await expect(
    deleteTaskGroup("table", "site", input("root")),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.writes).toHaveLength(0);
});

it.each(["root", "one"])(
  "deleting %s respects a live match to a different original",
  async (clickedId) => {
    put(task("root"));
    const other = put(task("other"));
    linked("one");
    const key = [...state.rows.keys()].find((key) =>
      key.startsWith("DUP_ISSUE#"),
    );
    const otherAnalysis = state.rows.get(
      `CHECK#${other.checkId}#ANALYSIS#${other.sourceArtifactIds[0]}`,
    );
    put({
      ...state.rows.get(key),
      duplicateOf: {
        observationId: `${other.checkId}:${other.sourceArtifactIds[0]}`,
        conditionId: other.conditionId,
        revision: analysisRevision(otherAnalysis),
      },
    });
    const scope = await deletionScope(
      "table",
      "site",
      state.rows.get(`TASK#${clickedId}`),
    );
    expect(scope.targets.map((target) => target.taskId)).toEqual([clickedId]);
    if (clickedId === "one")
      expect(scope).toMatchObject({ kind: "duplicate", rootTaskId: "other" });
    await deleteTaskGroup("table", "site", input(clickedId, [clickedId]));
    expect(state.rows.get("TASK#other").status).toBe("open");
    expect(
      state.rows.get(`TASK#${clickedId === "one" ? "root" : "one"}`).status,
    ).toBe("open");
  },
);
it("merges evidence guards into each unique transaction item within expression limits", async () => {
  put(task("root"));
  linked("one");
  linked("two");
  await deleteTaskGroup("table", "site", input("root"));
  const writes = state.writes[0];
  const keys = writes.map((entry) => {
    const key =
      entry.Put?.Item || entry.Update?.Key || entry.ConditionCheck?.Key;
    expect(key).toBeDefined();
    return key.sk;
  });
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of writes) {
    const operation = entry.Put || entry.Update || entry.ConditionCheck;
    expect(
      Buffer.byteLength(operation.ConditionExpression || ""),
    ).toBeLessThanOrEqual(4096);
    if (operation.ExpressionAttributeValues)
      expect(
        Object.keys(operation.ExpressionAttributeValues).length,
      ).toBeGreaterThan(0);
  }
});

it.each(["pending", "unavailable", "cycle", "large"])(
  "selected-only deletion bypasses %s grouping without touching siblings",
  async (stateName) => {
    put(task("root"));
    linked("one");
    linked("two");
    if (stateName === "cycle")
      put({
        pk: "SITE#site",
        sk: "DUP_LINK#root",
        taskId: "root",
        originalTaskId: "one",
      });
    else if (stateName === "large")
      for (let i = 0; i < 101; i++) linked(`extra-${i}`);
    else {
      const analysis = state.rows.get("CHECK#check-one#ANALYSIS#artifact-one");
      put({
        pk: "SITE#site",
        sk: `DUP_RESULT#check-one:artifact-one#${analysisRevision(analysis)}`,
        status: stateName === "pending" ? "pending" : "incomplete",
        invalidatedAt: "2026-11-03T00:00:00Z",
      });
    }
    const sibling = globalThis.structuredClone(state.rows.get("TASK#one"));
    const targets = await deleteTaskGroup("table", "site", {
      ...input("root", ["root"]),
      mode: "selected",
    });
    expect(targets.map((t) => t.taskId)).toEqual(["root"]);
    expect(state.rows.get("TASK#root").status).toBe("superseded");
    expect(state.rows.get("TASK#one")).toEqual(sibling);
    expect(
      (await groupForTask("table", "site", state.rows.get("TASK#one")))
        .rootTaskId,
    ).toBe("one");
    expect(state.writes[0]).toHaveLength(3);
    expect(
      await deleteTaskGroup("table", "site", {
        ...input("root", ["root"]),
        mode: "selected",
      }),
    ).toEqual(targets);
  },
);

it("selected-only mode still requires confirmation of exactly the selected task", async () => {
  put(task("root"));
  linked("one");
  await expect(
    deleteTaskGroup("table", "site", { ...input("root"), mode: "selected" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(state.writes).toHaveLength(0);
});

it("remaining sightings act independently after selected-only root deletion and matching cannot revive the root", async () => {
  put(task("root"));
  linked("one");
  await deleteTaskGroup("table", "site", {
    ...input("root", ["root"]),
    mode: "selected",
  });
  const remaining = state.rows.get("TASK#one");
  expect((await groupForTask("table", "site", remaining)).rootTaskId).toBe(
    "one",
  );
  expect((await duplicateForTask("table", "site", remaining)).state).toBe(
    "complete",
  );
  expect((await sharedActionTarget("table", "site", "one")).taskId).toBe("one");
  const writeCount = state.writes.length;
  await reconcileObservation(
    "table",
    "site",
    remaining.checkId,
    remaining.sourceArtifactIds[0],
  );
  expect(state.writes).toHaveLength(writeCount);
  expect(state.rows.get("TASK#root").status).toBe("superseded");
});

it("selected duplicate deletion leaves its original and sibling unchanged", async () => {
  put(task("root"));
  linked("one");
  linked("two");
  const original = globalThis.structuredClone(state.rows.get("TASK#root"));
  const sibling = globalThis.structuredClone(state.rows.get("TASK#two"));
  await deleteTaskGroup("table", "site", {
    ...input("one", ["one"]),
    mode: "selected",
  });
  expect(state.rows.get("TASK#root")).toEqual(original);
  expect(state.rows.get("TASK#two")).toEqual(sibling);
  expect(state.rows.has("DUP_LINK#one")).toBe(false);
});

it("selected deletion does not wait for a concurrently changing membership stamp", async () => {
  put(task("root"));
  linked("one");
  state.before = () =>
    put({ ...state.rows.get("TASK#root"), duplicateGroupVersion: "new-link" });
  await deleteTaskGroup("table", "site", {
    ...input("root", ["root"]),
    mode: "selected",
  });
  expect(state.rows.get("TASK#root").status).toBe("superseded");
  expect(state.rows.get("TASK#one").status).toBe("open");
});

it("does not replay a selected-only receipt as a successful wider group deletion", async () => {
  put(task("root"));
  linked("one");
  await deleteTaskGroup("table", "site", {
    ...input("root", ["root"]),
    mode: "selected",
  });
  await expect(
    deleteTaskGroup("table", "site", input("root", ["root", "one"])),
  ).rejects.toMatchObject({ statusCode: 409, code: "group_changed" });
  expect(state.rows.get("TASK#one").status).toBe("open");
  expect(state.writes).toHaveLength(1);
});

it("a selected-only replay of a prior group receipt reports only the selected task", async () => {
  put(task("root"));
  linked("one");
  await deleteTaskGroup("table", "site", input("root", ["root", "one"]));
  expect(
    (
      await deleteTaskGroup("table", "site", {
        ...input("root", ["root"]),
        mode: "selected",
      })
    ).map((target) => target.taskId),
  ).toEqual(["root"]);
  expect(state.writes).toHaveLength(1);
});
