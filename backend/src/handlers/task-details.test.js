// @ts-nocheck -- command mocks intentionally accept several AWS input shapes.
import { beforeEach, expect, it, vi } from "vitest";
import { activeCatalog } from "../analysis/guidance/catalog-registry.js";

const state = vi.hoisted(() => ({
  items: new Map(),
  transactions: [],
  completions: [],
  taskCreatedRuns: [],
  transactionError: null,
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
      if (state.transactionError) throw state.transactionError;
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
vi.mock("../analysis/guidance/guidance-store.js", () => ({
  executeTaskCreatedAppActions: async (options) => {
    state.taskCreatedRuns.push(options);
    return options.taskItems;
  },
  completeTaskWithAppActions: async (options) => {
    state.completions.push(options);
    return {
      ...state.items.get(`SITE#site|TASK#${options.taskId}`),
      ...options.taskPatch,
      status: "completed",
      completedAt: options.now.toISOString(),
      resolvedAt: options.now.toISOString(),
      completionMethod: options.completionMethod,
    };
  },
}));

import {
  getTaskDetails,
  recordCustomTaskAction,
  updateTaskAction,
} from "./task-details.js";

function put(item) {
  state.items.set(`${item.pk}|${item.sk}`, item);
}

function task(taskId, overrides = {}) {
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
    ...overrides,
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
  state.completions.length = 0;
  state.taskCreatedRuns.length = 0;
  state.transactionError = null;
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

it("maps equivalent same-label rules to their canonical selectable action", async () => {
  put(
    task("root", {
      category: "Someone in distress",
      ruleId: "DISTRESS-3",
    }),
  );
  const response = await getTaskDetails(event("duplicate"));
  const body = JSON.parse(response.body);
  expect(
    body.actions.filter((action) => action.label === "Call 911"),
  ).toHaveLength(1);
  expect(body.actions.map((action) => action.ruleId)).toContain(
    body.selectedRuleId,
  );
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
  expect(state.taskCreatedRuns[0].taskItems[0].ruleId).toBe("LITTER-1");
  expect(state.taskCreatedRuns[0].taskItems[0].actionOverride.ruleId).toBe(
    "LITTER-2",
  );
});

it("rejects action switching after an app action has executed", async () => {
  put(
    task("root", {
      appActionStatus: "submitted",
      appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
    }),
  );
  const response = await updateTaskAction(
    event("duplicate", { ruleId: "LITTER-2" }),
  );
  expect(response.statusCode).toBe(409);
  expect(state.transactions).toHaveLength(0);
});

it("returns a controlled conflict when the task changes concurrently", async () => {
  const conflict = new Error("conflict");
  conflict.name = "TransactionCanceledException";
  conflict.CancellationReasons = [{ Code: "ConditionalCheckFailed" }];
  state.transactionError = conflict;
  const response = await updateTaskAction(
    event("duplicate", { ruleId: "LITTER-2" }),
  );
  expect(response.statusCode).toBe(409);
});

it("rehydrates a persisted custom selection and text", async () => {
  put(
    task("root", {
      actionOverride: { type: "custom", originalRuleId: "LITTER-1" },
      customAction: { text: "Asked a neighbor", resolved: false },
    }),
  );
  const response = await getTaskDetails(event("duplicate"));
  const body = JSON.parse(response.body);
  expect(body.selectedRuleId).toBe("__custom__");
  expect(body.customAction.text).toBe("Asked a neighbor");
});

it("records an unresolved custom action and its timeline transition", async () => {
  const resolved = false;
  const response = await recordCustomTaskAction(
    event("duplicate", { text: "Asked a neighbor to help", resolved }),
  );
  const body = JSON.parse(response.body);
  expect(body.task).toMatchObject({ status: "in_progress", appActions: [] });
  const eventPut = state.transactions[0].find(
    (entry) => entry.Put?.Item.entityType === "task_update",
  );
  expect(eventPut.Put.Item).toMatchObject({
    type: "custom_action_taken",
    text: "Asked a neighbor to help",
    actorId: "actor",
  });
});

it("uses the guarded completion flow for a resolved custom action", async () => {
  const response = await recordCustomTaskAction(
    event("duplicate", {
      text: "Asked a neighbor to help",
      resolved: true,
    }),
  );
  expect(JSON.parse(response.body).task).toMatchObject({
    status: "completed",
    resolvedAt: expect.any(String),
    completionMethod: "custom_action",
  });
  expect(state.completions[0]).toMatchObject({
    taskId: "root",
    forceComplete: true,
    skipUserConfirmedActions: true,
    timelineType: "task_completed",
    timelineText: "Asked a neighbor to help",
  });
});
