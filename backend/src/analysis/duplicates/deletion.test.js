// @ts-nocheck -- in-memory command harness exercises transaction boundaries.
import { beforeEach, expect, it, vi } from "vitest";
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
        const write = entry.Put;
        const guard = entry.ConditionCheck;
        const row = state.rows.get(write?.Item.sk || guard?.Key.sk);
        let conflict = false;
        if (write?.Item.sk.startsWith("TASK#")) {
          const expected = write.ExpressionAttributeValues;
          conflict =
            row.status !== expected[":status"] ||
            row.updatedAt !== expected[":updatedAt"] ||
            row.duplicateGroupVersion !== expected[":groupVersion"];
        }
        if (guard?.Key.sk.startsWith("DUP_OVERRIDE#")) conflict = Boolean(row);
        if (guard?.Key.sk.startsWith("DUP_LINK#")) {
          const expected = guard.ExpressionAttributeValues;
          conflict =
            row?.originalTaskId !== expected[":root"] ||
            row?.sourceRevision !== expected[":revision"];
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
      for (const { Put } of input.TransactItems)
        if (Put) state.rows.set(Put.Item.sk, Put.Item);
      return {};
    },
  },
}));
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
  return row;
}
function linked(id, status) {
  put(task(id, status));
  put({
    pk: "SITE#site",
    sk: `DUP_LINK#${id}`,
    taskId: id,
    originalTaskId: "root",
    sourceRevision: "revision",
  });
}
function input(id, expectedTaskIds) {
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
  expect(guards).toHaveLength(6);
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
