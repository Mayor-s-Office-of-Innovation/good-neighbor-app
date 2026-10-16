// @ts-nocheck -- command mocks intentionally accept several AWS input shapes.
import { beforeEach, expect, it, vi } from "vitest";
import { activeCatalog } from "../analysis/guidance/catalog-registry.js";

const state = vi.hoisted(() => ({
  items: new Map(),
  transactions: [],
}));

vi.mock("../db.js", () => ({
  ddb: {
    send: async (command) => {
      const input = command.input;
      if (input.Key) {
        return { Item: state.items.get(`${input.Key.pk}|${input.Key.sk}`) };
      }
      if (input.KeyConditionExpression) {
        const prefix = input.ExpressionAttributeValues[":prefix"];
        return {
          Items: [...state.items.values()].filter(
            (item) =>
              item.pk === input.ExpressionAttributeValues[":pk"] &&
              item.sk.startsWith(prefix),
          ),
        };
      }
      state.transactions.push(input.TransactItems);
      for (const entry of input.TransactItems ?? []) {
        if (entry.Put) {
          const item = entry.Put.Item;
          state.items.set(`${item.pk}|${item.sk}`, item);
        }
      }
      return {};
    },
  },
}));
vi.mock("../config.js", () => ({
  getConfig: () => ({ dynamoTable: "test" }),
}));
vi.mock("../lib/principal.js", () => ({
  deriveSiteId: () => "site",
  deriveActorId: () => "actor",
}));
vi.mock("../analysis/duplicates/links.js", () => ({
  sharedActionTarget: async (_table, _site, taskId) => ({
    taskId: taskId === "duplicate" ? "root" : taskId,
    duplicateChecks: [],
  }),
}));

import {
  getTaskDetails,
  recordCustomTaskAction,
  updateTaskAction,
} from "./task-details.js";

function put(item) {
  state.items.set(`${item.pk}|${item.sk}`, item);
}

function task(taskId) {
  const now = "2026-10-16T12:00:00.000Z";
  return {
    pk: "SITE#site",
    sk: `TASK#${taskId}`,
    taskId,
    status: "open",
    category: "Litter",
    policyVersion: activeCatalog().policyVersion,
    ruleId: "LITTER-1",
    kind: "action",
    severity: 1,
    createdAt: now,
    updatedAt: now,
    buttons: ["Pick up the litter"],
    appActions: [],
  };
}

function event(taskId, body) {
  return {
    pathParameters: { taskId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

beforeEach(() => {
  state.items.clear();
  state.transactions.length = 0;
  put(task("root"));
  put(task("duplicate"));
  put({
    pk: "SITE#site",
    sk: "DUP_LINK#duplicate",
    taskId: "duplicate",
    originalTaskId: "root",
    sourceRevision: "rev-1",
  });
});

it("returns the full group and distinct category actions from either member", async () => {
  const response = await getTaskDetails(event("duplicate"));
  const body = JSON.parse(response.body);
  expect(body.rootTaskId).toBe("root");
  expect(body.members.map((member) => member.taskId)).toEqual([
    "root",
    "duplicate",
  ]);
  expect(
    body.members.find((member) => member.taskId === "duplicate"),
  ).toMatchObject({ isDuplicate: true, sourceRevision: "rev-1" });
  expect(body.actions.map((action) => action.label)).toEqual([
    "Pick up the litter",
    "File 311 ticket",
  ]);
});

it("persists a complete rule override without replacing the evaluated rule id", async () => {
  const response = await updateTaskAction(
    event("duplicate", { ruleId: "LITTER-2" }),
  );
  const body = JSON.parse(response.body);
  expect(body.task.ruleId).toBe("LITTER-1");
  expect(body.task.actionOverride).toMatchObject({
    ruleId: "LITTER-2",
    originalRuleId: "LITTER-1",
  });
  expect(body.task.buttons).toEqual(["File 311 ticket"]);
  expect(body.task.canBeInProgress).toBe(true);
});

it.each([
  [true, "completed", "task_completed"],
  [false, "in_progress", "custom_action_taken"],
])(
  "records a custom action and its timeline transition",
  async (resolved, status, type) => {
    const response = await recordCustomTaskAction(
      event("duplicate", { text: "Asked a neighbor to help", resolved }),
    );
    const body = JSON.parse(response.body);
    expect(body.task).toMatchObject({ status, appActions: [] });
    const eventPut = state.transactions[0].find(
      (entry) => entry.Put?.Item.entityType === "task_update",
    );
    expect(eventPut.Put.Item).toMatchObject({
      type,
      text: "Asked a neighbor to help",
      actorId: "actor",
    });
  },
);
