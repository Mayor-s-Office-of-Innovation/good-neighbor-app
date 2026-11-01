import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import {
  deliberate311Decision,
  simulated311Ticket,
  simulated311Detail,
} from "./deliberate-311.js";
import {
  executeAppActions,
  eligibleTicketsForClosure,
} from "../analysis/guidance/app-actions.js";
import { completeTaskWithAppActions } from "../analysis/guidance/guidance-store.js";
import { runJob } from "../workers/sf311-job.js";
const now = "2026-10-30T12:00:00.000Z";
const task = {
  taskId: "task",
  deliberate311DeliveryMode: "simulated",
  deliberate311AcceptedAt: now,
};
const action = {
  code: "create_311_ticket",
  payload: {
    executionTrigger: "user_confirmed",
    serviceCodeOrAction: "Run bulky item analysis",
  },
};
beforeEach(() => {
  send.mockReset().mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([undefined, true, "false", null])(
  "defaults to production unless explicitly false (%s)",
  async (value) => {
    send.mockResolvedValue({ Item: { deliberate311ProductionEnabled: value } });
    const decision = await deliberate311Decision("table", "site", {}, now);
    expect(decision.mode).toBe("production");
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(decision.checks).toHaveLength(1);
  },
);
it("snapshots explicit disablement and guards the Site flag in the acceptance transaction", async () => {
  send.mockResolvedValue({ Item: { deliberate311ProductionEnabled: false } });
  const decision = await deliberate311Decision("table", "site", {}, now);
  expect(decision).toMatchObject({ mode: "simulated", acceptedAt: now });
  expect(decision.checks[0].ConditionCheck).toMatchObject({
    ConditionExpression: "deliberate311ProductionEnabled = :enabled",
    ExpressionAttributeValues: { ":enabled": false },
  });
});
it.each(["production", "simulated"])(
  "keeps accepted %s mode across a flag change without reading the Site",
  async (mode) => {
    expect(
      await deliberate311Decision(
        "table",
        "site",
        { ...task, deliberate311DeliveryMode: mode },
        "2026-11-01T00:00:00Z",
      ),
    ).toMatchObject({ mode, acceptedAt: now, checks: [] });
    expect(send).not.toHaveBeenCalled();
  },
);
it("uses stable references scoped to the Site and closes exactly five minutes after acceptance", () => {
  const ticket = simulated311Ticket("site", task, now);
  expect(ticket).toEqual(
    simulated311Ticket("site", task, "2026-11-01T00:00:00Z"),
  );
  expect(ticket.srNum).not.toBe(
    simulated311Ticket("another-site", task, now).srNum,
  );
  expect(
    simulated311Detail(task, ticket, new Date("2026-10-30T12:04:59.999Z")),
  ).toMatchObject({ status: "Open", submittedAt: now });
  const closed = simulated311Detail(
    task,
    ticket,
    new Date("2026-10-30T12:05:00.000Z"),
  );
  expect(closed).toMatchObject({
    status: "Closed",
    closedReason: "1",
    closureReason: "Resolved",
    responseOverdue: false,
  });
  expect(closed.events).toContainEqual(
    expect.objectContaining({ kind: "resolved", occurredAt: ticket.closesAt }),
  );
});
it("files successfully without classifiers, media, credentials or City calls, and reuses its ticket on retry", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const opts = {
    task,
    siteId: "site",
    trigger: /** @type {const} */ ("user_confirmed"),
    now: new Date(now),
    env: { GNP_311_SUBMISSION_ENABLED: "true" },
  };
  const results = await executeAppActions([action], opts);
  expect(results[0]).toMatchObject({
    status: "submitted",
    payload: {
      tickets: [
        { deliveryMode: "simulated", srNum: expect.stringMatching(/^SIM-/) },
      ],
    },
  });
  expect(
    await executeAppActions([action], { ...opts, priorResults: results }),
  ).toEqual(results);
  expect(send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(eligibleTicketsForClosure(results).size).toBe(0);
});
it("never simulates silent filings just because the Site is disabled", async () => {
  vi.stubEnv("S3_UPLOAD_BUCKET", "bucket");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  vi.stubEnv("DYNAMO_TABLE", "table");
  const results = await executeAppActions(
    [
      {
        ...action,
        payload: { executionTrigger: "task_created", serviceCodeOrAction: "" },
      },
    ],
    {
      task,
      trigger: "task_created",
      env: { ...process.env, GNP_311_SUBMISSION_ENABLED: "true" },
    },
  );
  expect(results[0]).toMatchObject({
    status: "failed",
    reason: "missing_service_code",
  });
});
it("honors the global kill switch for simulated filings", async () => {
  const results = await executeAppActions([action], {
    task,
    trigger: "user_confirmed",
    env: { GNP_311_SUBMISSION_ENABLED: "false" },
  });
  expect(results[0]).toMatchObject({
    status: "skipped",
    reason: "feature_disabled",
  });
});
it.each([true, false])(
  "persists the selected mode with the accepted filing (async=%s)",
  async (async) => {
    const existing = {
      taskId: "task",
      status: "open",
      kind: "escalation",
      canBeInProgress: true,
      appActions: [action],
    };
    send.mockImplementation(async (command) =>
      command instanceof GetCommand
        ? {
            Item:
              command.input.Key?.sk === "#META"
                ? { deliberate311ProductionEnabled: false }
                : existing,
          }
        : {},
    );
    const result = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site",
      taskId: "task",
      completionMethod: "311_filed",
      now: new Date(now),
      env: {
        GNP_311_SUBMISSION_ENABLED: "true",
        GNP_311_ASYNC_FILING: String(async),
      },
    });
    expect(result).toMatchObject({
      deliberate311DeliveryMode: "simulated",
      deliberate311AcceptedAt: now,
    });
    const claim = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    if (!claim) throw new Error("Expected acceptance transaction");
    expect(claim.input.TransactItems).toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          ExpressionAttributeValues: { ":enabled": false },
        }),
      }),
    );
    if (async)
      expect(claim.input.TransactItems).toContainEqual(
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              entityType: "SF311_OUTBOX",
              deliveryMode: "simulated",
            }),
          }),
        }),
      );
    else expect(result).toMatchObject({ appActionStatus: "submitted" });
  },
);
it("worker files and checkpoints a simulated request without City calls", async () => {
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  vi.stubEnv("S3_UPLOAD_BUCKET", "bucket");
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "true");
  const fetch = vi.spyOn(globalThis, "fetch");
  const queued = {
    ...task,
    status: "in_progress",
    inProgressActionKind: "311_filed",
    appActionStatus: "queued",
    appActions: [action],
    canBeInProgress: true,
  };
  const job = {
    trigger: "user_confirmed",
    status: "pending",
    deliveryMode: "simulated",
  };
  send.mockImplementation(async (command) =>
    command instanceof GetCommand
      ? { Item: command.input.Key?.sk.startsWith("SF311_JOB#") ? job : queued }
      : {},
  );
  await runJob({
    siteId: "site",
    taskId: "task",
    jobPk: "SITE#site",
    jobSk: "SF311_JOB#task#filed-test",
  });
  const writes = send.mock.calls.flatMap(
    ([command]) => command.input.TransactItems || [],
  );
  expect(writes).toContainEqual(
    expect.objectContaining({
      Update: expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":status": "complete",
        }),
      }),
    }),
  );
  expect(JSON.stringify(writes)).toContain('"deliveryMode":"simulated"');
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps legacy real or uncertain attempts real after disablement", async () => {
  const decision = await deliberate311Decision(
    "table",
    "site",
    {
      appActionResults: [
        {
          code: "create_311_ticket",
          recordedAt: now,
          payload: {
            tickets: [{ serviceCode: "code", creationState: "pending" }],
          },
        },
      ],
    },
    now,
  );
  expect(decision.mode).toBe("production");
  expect(send).not.toHaveBeenCalled();
});

it.each([true, false])(
  "rejects a concurrent Site flag change before executing or queuing (async=%s)",
  async (async) => {
    const existing = { taskId: "task", status: "open", appActions: [action] };
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item:
            command.input.Key?.sk === "#META"
              ? { deliberate311ProductionEnabled: false }
              : existing,
        };
      if (command instanceof TransactWriteCommand)
        throw Object.assign(new Error("changed"), {
          name: "TransactionCanceledException",
        });
      return {};
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      completeTaskWithAppActions({
        tableName: "table",
        siteId: "site",
        taskId: "task",
        completionMethod: "311_filed",
        now: new Date(now),
        env: {
          GNP_311_SUBMISSION_ENABLED: "true",
          GNP_311_ASYNC_FILING: String(async),
        },
      }),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([undefined, "user_confirmed", "manual"])(
  "cannot bypass simulation with completionMethod=%s",
  async (completionMethod) => {
    const existing = {
      taskId: "task",
      status: "open",
      kind: "escalation",
      canBeInProgress: true,
      appActions: [action],
    };
    send.mockImplementation(async (command) =>
      command instanceof GetCommand
        ? {
            Item:
              command.input.Key?.sk === "#META"
                ? { deliberate311ProductionEnabled: false }
                : existing,
          }
        : {},
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site",
      taskId: "task",
      completionMethod,
      now: new Date(now),
      env: { GNP_311_SUBMISSION_ENABLED: "true", GNP_311_ASYNC_FILING: "true" },
    });
    expect(result).toMatchObject({
      deliberate311DeliveryMode: "simulated",
      appActionStatus: "submitted",
      appActionResults: [
        { payload: { tickets: [{ deliveryMode: "simulated" }] } },
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "first deliberate filing after silent history reads site delivery setting %s",
  async (enabled) => {
    send.mockResolvedValue({
      Item: { deliberate311ProductionEnabled: enabled },
    });
    const decision = await deliberate311Decision(
      "table",
      "site",
      {
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            recordedAt: now,
            payload: {
              executionTrigger: "task_created",
              tickets: [{ srNum: "123", responsibleAgency: "76" }],
            },
          },
        ],
      },
      now,
    );
    expect(decision.mode).toBe(enabled ? "production" : "simulated");
    expect(decision.acceptedAt).toBe(now);
    expect(send).toHaveBeenCalledOnce();
    expect(decision.checks).toHaveLength(1);
  },
);

it("pins an actual deliberate attempt independently of earlier silent history", async () => {
  const decision = await deliberate311Decision(
    "table",
    "site",
    {
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: {
            executionTrigger: "task_created",
            tickets: [{ srNum: "123" }],
          },
        },
        {
          code: "create_311_ticket",
          recordedAt: now,
          payload: {
            executionTrigger: "user_confirmed",
            tickets: [{ srNum: "SIM-123", deliveryMode: "simulated" }],
          },
        },
      ],
    },
    now,
  );
  expect(decision.mode).toBe("simulated");
  expect(send).not.toHaveBeenCalled();
});

it("simulates a newly selected deliberate action despite an existing real silent ticket", async () => {
  send.mockResolvedValue({ Item: { deliberate311ProductionEnabled: false } });
  const silent = {
    code: "create_311_ticket",
    status: "submitted",
    recordedAt: now,
    payload: {
      executionTrigger: "task_created",
      responsibleAgencyCode: "76",
      tickets: [
        { srNum: "123", responsibleAgency: "76", serviceCode: "synthetic" },
      ],
    },
  };
  const existing = { taskId: "task", appActionResults: [silent] };
  const decision = await deliberate311Decision("table", "site", existing, now);
  const fetch = vi.fn(() => {
    throw new Error("Unexpected external request");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const results = await executeAppActions([action], {
      env: { GNP_311_SUBMISSION_ENABLED: "true" },
      trigger: "user_confirmed",
      siteId: "site",
      tableName: "table",
      now: new Date(now),
      task: {
        ...existing,
        deliberate311DeliveryMode: decision.mode,
        deliberate311AcceptedAt: decision.acceptedAt,
      },
      priorResults: existing.appActionResults,
    });
    expect(results[0]).toMatchObject({
      status: "submitted",
      payload: {
        tickets: [
          { deliveryMode: "simulated", srNum: expect.stringMatching(/^SIM-/) },
        ],
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
