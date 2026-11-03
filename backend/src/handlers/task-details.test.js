// @ts-nocheck -- command mocks intentionally accept several AWS input shapes.
import { isDeepStrictEqual } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { activeCatalog } from "../analysis/guidance/catalog-registry.js";

const state = vi.hoisted(() => ({
  items: new Map(),
  transactions: [],
  completions: [],
  taskCreatedRuns: [],
  transactionError: null,
  beforeTransaction: null,
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
      state.beforeTransaction?.(input.TransactItems);
      if (state.transactionError) throw state.transactionError;
      for (const entry of input.TransactItems ?? []) {
        const guard = entry.ConditionCheck;
        if (guard?.Key.sk.startsWith("SF311_LOCK#")) {
          const lock = state.items.get(`${guard.Key.pk}|${guard.Key.sk}`);
          if (
            (lock?.sf311Lease &&
              !(
                lock.sf311Lease ===
                  guard.ExpressionAttributeValues?.[":observedLease"] &&
                lock.sf311LeaseExpiresAt ===
                  guard.ExpressionAttributeValues?.[":leaseExpires"] &&
                lock.sf311LeaseExpiresAt <
                  guard.ExpressionAttributeValues?.[":leaseNow"]
              )) ||
            !isDeepStrictEqual(
              lock?.results,
              guard.ExpressionAttributeValues?.[":lockResults"],
            )
          )
            throw Object.assign(new Error("worker won"), {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
            });
        }
      }
      for (const { Put: write } of input.TransactItems ?? []) {
        if (!write?.ConditionExpression?.includes("updatedAt = :updated"))
          continue;
        const current = state.items.get(`${write.Item.pk}|${write.Item.sk}`);
        const expected = write.ExpressionAttributeValues;
        if (
          current.status !== expected[":open"] ||
          current.updatedAt !== expected[":updated"] ||
          !isDeepStrictEqual(current.appActionResults, expected[":results"])
        )
          throw Object.assign(new Error("task changed"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
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
vi.mock("../analysis/duplicates/links.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sharedActionTarget: async (_table, _site, taskId) => ({
    taskId: taskId === "duplicate" ? "root" : taskId,
    duplicateChecks: [],
  }),
}));
vi.mock("../analysis/guidance/guidance-store.js", () => ({
  conditionDeletionKey: (site, input, task) => ({
    pk: `SITE#${site}`,
    sk: `ISSUE_DELETION#${task.checkId}:${task.sourceArtifactIds[0]}:${task.conditionId}`,
  }),
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
  state.beforeTransaction = null;
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
  expect(body).not.toHaveProperty("deletion");
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

it.each([undefined, "unsupported-policy"])(
  "returns deletion scope independently of policy version %s",
  async (policyVersion) => {
    put(
      task("standalone", {
        policyVersion,
        checkId: "check",
        conditionId: "condition",
        sourceArtifactIds: ["artifact"],
      }),
    );
    const response = await getTaskDetails({
      ...event("standalone"),
      queryStringParameters: { view: "deletion" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      deletion: {
        kind: "single",
        targets: [
          {
            taskId: "standalone",
            originalTaskId: "standalone",
            checkId: "check",
            artifactId: "artifact",
            conditionId: "condition",
          },
        ],
      },
    });
    await expect(getTaskDetails(event("standalone"))).rejects.toMatchObject({
      name: "CatalogUnavailable",
    });
  },
);

it("fails closed when deletion-only scope cannot be validated", async () => {
  const response = await getTaskDetails({
    ...event("root"),
    queryStringParameters: { view: "deletion" },
  });
  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body).deletion).toBeUndefined();
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
  expect(state.taskCreatedRuns).toHaveLength(0);
  expect(body.task.actionOverride.ruleId).toBe("LITTER-2");
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

it("atomically records a resolved custom action without executing its prior actions", async () => {
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
  expect(state.completions).toHaveLength(0);
  expect(state.transactions).toHaveLength(1);
  expect(
    state.transactions[0].some(
      (entry) => entry.ConditionCheck?.Key.sk === "SF311_LOCK#root",
    ),
  ).toBe(true);
  expect(
    state.transactions[0].find(
      (entry) => entry.Put?.Item.entityType === "task_update",
    ).Put.Item,
  ).toMatchObject({ type: "task_completed", text: "Asked a neighbor to help" });
});

it.each(["lease", "checkpoint", "finalized"])(
  "rejects an override when worker %s appears after its read",
  async (phase) => {
    state.beforeTransaction = (entries) => {
      const guard = entries.find(
        (e) => e.ConditionCheck?.Key.sk === "SF311_LOCK#root",
      ).ConditionCheck;
      expect(guard.ConditionExpression).toBe(
        "attribute_not_exists(sf311Lease) AND attribute_not_exists(results)",
      );
      const taskWrite = entries.find((e) => e.Put?.Item.sk === "TASK#root").Put;
      expect(taskWrite.ConditionExpression).toContain(
        "attribute_not_exists(appActionResults)",
      );
      put({
        pk: "SITE#site",
        sk: "SF311_LOCK#root",
        ...(phase === "lease"
          ? { sf311Lease: "worker" }
          : { results: [{ code: "create_311_ticket" }] }),
      });
      if (phase === "finalized")
        put(
          task("root", {
            appActionResults: [
              { code: "create_311_ticket", status: "submitted" },
            ],
          }),
        );
    };
    const response = await updateTaskAction(
      event("duplicate", { ruleId: "LITTER-2" }),
    );
    expect(response.statusCode).toBe(409);
    expect(state.transactions).toHaveLength(0);
  },
);

function silentResult(overrides = {}) {
  return {
    code: "create_311_ticket",
    status: "submitted",
    recordedAt: "2026-10-16T12:00:01Z",
    payload: {
      executionTrigger: "task_created",
      responsibleAgencyCode: "76",
      tickets: [
        {
          serviceCode: "synthetic",
          srNum: "123456789",
          responsibleAgency: "76",
        },
      ],
    },
    ...overrides,
  };
}
function settledTask(result) {
  put(
    task("root", {
      appActionResults: [result],
      appActionStatus: result.status,
    }),
  );
  put({ pk: "SITE#site", sk: "SF311_LOCK#root", results: [result] });
}

it.each([
  "expired",
  "active",
  "missing-expiry",
  "malformed-expiry",
  "reclaimed",
])(
  "permits only a settled result with a safely expired lease: %s",
  async (mode) => {
    const result = silentResult();
    settledTask(result);
    const lock = state.items.get("SITE#site|SF311_LOCK#root");
    lock.sf311Lease = "old-worker";
    if (mode !== "missing-expiry")
      lock.sf311LeaseExpiresAt =
        mode === "malformed-expiry"
          ? "bad"
          : mode === "active"
            ? "2999-01-01T00:00:00.000Z"
            : "2020-01-01T00:00:00.000Z";
    if (mode === "reclaimed")
      state.beforeTransaction = () => {
        lock.sf311Lease = "new-worker";
        lock.sf311LeaseExpiresAt = "2999-01-01T00:00:00.000Z";
      };
    const response = await updateTaskAction(
      event("root", { ruleId: "LITTER-2" }),
    );
    expect(response.statusCode).toBe(mode === "expired" ? 200 : 409);
    expect(state.items.get("SITE#site|TASK#root").appActionResults).toEqual([
      result,
    ]);
    expect(lock.results).toEqual([result]);
  },
);

it.each(["submitted", "rejected", "preflight"])(
  "allows settled silent %s while preserving task and lock results",
  async (kind) => {
    const result = silentResult();
    if (kind !== "submitted") {
      result.status = "failed";
      result.reason = kind === "preflight" ? "missing_location" : "21";
      result.payload.tickets =
        kind === "preflight"
          ? []
          : [
              {
                serviceCode: "synthetic",
                responsibleAgency: "76",
                creationState: "rejected",
              },
            ];
    }
    settledTask(result);
    const response = await updateTaskAction(
      event("root", { ruleId: "LITTER-2" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).task.appActionResults).toEqual([result]);
    expect(state.items.get("SITE#site|SF311_LOCK#root").results).toEqual([
      result,
    ]);
    const guard = state.transactions[0].find(
      (e) => e.ConditionCheck?.Key.sk === "SF311_LOCK#root",
    ).ConditionCheck;
    expect(guard.ConditionExpression).toBe(
      "attribute_not_exists(sf311Lease) AND results = :lockResults",
    );
    expect(guard.ExpressionAttributeValues[":lockResults"]).toEqual([result]);
  },
);

it.each(["lease", "user", "phone"])(
  "blocks %s outcomes without changing history",
  async (kind) => {
    const result = silentResult();
    if (kind === "user") result.payload.executionTrigger = "user_confirmed";
    if (kind === "phone") {
      result.code = "open_phone";
      result.status = "recorded";
    }
    settledTask(result);
    if (kind === "lease")
      state.items.get("SITE#site|SF311_LOCK#root").sf311Lease = "active-worker";
    expect(
      (await updateTaskAction(event("root", { ruleId: "LITTER-2" })))
        .statusCode,
    ).toBe(409);
    expect(state.transactions).toHaveLength(0);
  },
);

it.each(["attachment", "partial", "pending", "uncertain", "unmirrored"])(
  "allows a combined edit with silent %s history without altering the ticket",
  async (kind) => {
    const result = silentResult({ status: "failed" });
    if (kind === "attachment") result.reason = "attachment_submission_failed";
    if (kind === "partial") result.status = "partial";
    if (kind === "pending")
      result.payload.tickets = [
        { responsibleAgency: "76", creationState: "pending" },
      ];
    if (kind === "uncertain")
      result.reason = "sf311_creation_uncertain_requires_reconciliation";
    settledTask(result);
    if (kind === "unmirrored") put(task("root", { appActionResults: [] }));
    const original = globalThis.structuredClone(
      state.items.get("SITE#site|TASK#root"),
    );
    const lock = globalThis.structuredClone(
      state.items.get("SITE#site|SF311_LOCK#root"),
    );
    const response = await updateTaskAction(
      event("root", {
        ruleId: "LITTER-2",
        description: "Updated synthetic observation",
      }),
    );
    expect(response.statusCode).toBe(200);
    const saved = JSON.parse(response.body).task;
    expect(saved.description).toBe("Updated synthetic observation");
    expect(saved.actionOverride.ruleId).toBe("LITTER-2");
    expect(saved.appActionResults).toEqual(original.appActionResults);
    expect(saved.silent311Snapshot.appActions).toEqual(original.appActions);
    expect(state.items.get("SITE#site|SF311_LOCK#root")).toEqual(lock);
    expect(
      state.transactions
        .flat()
        .some((entry) => entry.Put?.Item.sk?.startsWith("SF311_JOB#")),
    ).toBe(false);
  },
);

it.each(["lock", "task", "lease"])(
  "rejects concurrent %s changes after settled snapshot read",
  async (kind) => {
    settledTask(silentResult());
    state.beforeTransaction = () => {
      if (kind === "task")
        put(task("root", { updatedAt: "2026-11-01T19:00:00Z" }));
      else
        put({
          pk: "SITE#site",
          sk: "SF311_LOCK#root",
          results: [silentResult({ status: "partial" })],
          ...(kind === "lease" ? { sf311Lease: "worker" } : {}),
        });
    };
    expect(
      (await updateTaskAction(event("root", { ruleId: "LITTER-2" })))
        .statusCode,
    ).toBe(409);
    expect(state.transactions).toHaveLength(0);
  },
);

it("never queues a silent filing on an action edit, even when submission is enabled", async () => {
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "true");
  const original = state.items.get("SITE#site|TASK#root");
  const response = await updateTaskAction(
    event("duplicate", { ruleId: "LITTER-2" }),
  );
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).task.silent311Snapshot.appActions).toEqual(
    original.appActions,
  );
  expect(
    state.transactions
      .flat()
      .some((entry) => entry.Put?.Item.entityType === "SF311_OUTBOX"),
  ).toBe(false);
  vi.unstubAllEnvs();
});

it("saves action and clicked duplicate description together without rewriting the root description", async () => {
  const response = await updateTaskAction(
    event("duplicate", {
      ruleId: "LITTER-2",
      description: "A corrected observation",
    }),
  );
  expect(response.statusCode).toBe(200);
  expect(state.transactions).toHaveLength(1);
  const tx = state.transactions[0];
  expect(
    tx.find((entry) => entry.Update?.Key.sk === "TASK#duplicate").Update
      .ExpressionAttributeValues[":text"],
  ).toBe("A corrected observation");
  expect(
    tx.find((entry) => entry.Put?.Item.sk === "TASK#root").Put.Item.description,
  ).not.toBe("A corrected observation");
});

it("locks description corrections after a user action", async () => {
  put(
    task("root", {
      status: "open",
      appActionResults: [{ status: "submitted" }],
    }),
  );
  const response = await updateTaskAction(
    event("root", { description: "Corrected observation text" }),
  );
  expect(response.statusCode).toBe(409);
  expect(state.transactions).toHaveLength(0);
});

it("replays a custom-action save after a lost response without another timeline entry", async () => {
  const input = event("root", {
    text: "Asked the team to help",
    resolved: true,
    requestId: "synthetic-edit-request",
  });
  expect((await recordCustomTaskAction(input)).statusCode).toBe(200);
  expect((await recordCustomTaskAction(input)).statusCode).toBe(200);
  expect(state.transactions).toHaveLength(1);
});

it("changes shared category and guidance while editing only the opened observation title", async () => {
  const rule = activeCatalog().rules.find(
    (rule) => rule.category === "Graffiti" && rule.outcome.buttons[0],
  );
  const response = await updateTaskAction(
    event("duplicate", {
      title: "Paint on the wall",
      description: "A synthetic observation",
      category: rule.category,
      ruleId: rule.ruleId,
    }),
  );
  expect(response.statusCode).toBe(200);
  const saved = JSON.parse(response.body).task;
  expect(saved.category).toBe("Graffiti");
  expect(saved.guidance).toBe(rule.outcome.guidance);
  expect(saved.userFriendlyLabel).not.toBe("Paint on the wall");
  const clicked = state.transactions[0].find(
    (entry) => entry.Update?.Key.sk === "TASK#duplicate",
  );
  expect(clicked.Update.ExpressionAttributeValues[":title"]).toBe(
    "Paint on the wall",
  );
});
it("requires an explicit action from the chosen category", async () => {
  expect(
    (
      await updateTaskAction(
        event("root", {
          category: "Graffiti",
          description: "A synthetic observation",
        }),
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await updateTaskAction(
        event("root", { category: "Graffiti", ruleId: "LITTER-2" }),
      )
    ).statusCode,
  ).toBe(400);
});
it.each(["in_progress", "completing", "completed"])(
  "locks every field for %s tasks",
  async (status) => {
    put(task("root", { status }));
    expect(
      (
        await updateTaskAction(
          event("root", { title: "New title", description: "New description" }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await updateTaskAction(
          event("duplicate", { description: "New description" }),
        )
      ).statusCode,
    ).toBe(409);
  },
);
it("clears inherited guidance for a custom action", async () => {
  put(task("root", { guidance: "Original guidance" }));
  const response = await recordCustomTaskAction(
    event("root", {
      text: "Called the team",
      resolved: false,
      category: "Graffiti",
    }),
  );
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).task).toMatchObject({
    category: "Graffiti",
    guidance: "",
    status: "in_progress",
  });
});
