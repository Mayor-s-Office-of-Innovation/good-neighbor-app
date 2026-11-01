import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
const { send, execute, sendSqs } = vi.hoisted(() => ({
  send: vi.fn(),
  sendSqs: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@aws-sdk/client-sqs", async (original) => ({
  ...(await original()),
  SQSClient: class {
    send = sendSqs;
  },
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({
  getConfig: () => ({
    dynamoTable: "test",
    queueUrl: "queue",
    sf311QueueUrl: "https://sqs.example/311",
  }),
}));
vi.mock("../analysis/guidance/app-actions.js", async (original) => ({
  ...(await original()),
  executeAppActions: execute,
}));
const { runJob, mergeBackgroundResult, handler, retryDelaySeconds } =
  await import("./sf311-job.js");
const message = {
  siteId: "site",
  taskId: "task",
  jobPk: "SITE#site",
  jobSk: "SF311_JOB#task#created",
};
/** @type {import("../analysis/guidance/app-actions.js").AppActionResult} */
const ticket = {
  code: "create_311_ticket",
  status: "submitted",
  recordedAt: "2026-10-26T12:00:00Z",
  payload: {
    tickets: [{ serviceCode: "code", srNum: "123", responsibleAgency: "76" }],
  },
};
/** @type {any} */
let task;
/** @type {any} */
let job;
/** @type {any[]} */
let finalWrites;
/** @type {any} */
let lock;
beforeEach(() => {
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "true");
  task = {
    pk: "SITE#site",
    sk: "TASK#task",
    taskId: "task",
    status: "open",
    appActions: [
      {
        code: "create_311_ticket",
        payload: { executionTrigger: "task_created" },
      },
    ],
    appActionResults: [],
  };
  sendSqs.mockReset().mockResolvedValue({});
  lock = {};
  job = { status: "dispatched" };
  finalWrites = [];
  execute.mockReset().mockResolvedValue([ticket]);
  send.mockReset().mockImplementation(async (command) => {
    const input = command.input;
    if (command instanceof GetCommand)
      return {
        Item: globalThis.structuredClone(
          input.Key.sk.startsWith("SF311_JOB#")
            ? job
            : input.Key.sk.startsWith("SF311_LOCK#")
              ? lock
              : task,
        ),
      };
    if (command instanceof UpdateCommand) {
      if (input.UpdateExpression.startsWith("SET sf311Lease")) {
        lock.sf311Lease = input.ExpressionAttributeValues[":token"];
        return { Attributes: globalThis.structuredClone(lock) };
      }
      delete lock.sf311Lease;
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      for (const entry of input.TransactItems) {
        if (!entry.Update) continue;
        const update = entry.Update,
          values = update.ExpressionAttributeValues;
        if (update.Key.sk.startsWith("SF311_JOB#")) {
          job.results = globalThis.structuredClone(values[":results"]);
          if (values[":status"]) job.status = values[":status"];
        } else if (update.Key.sk.startsWith("SF311_LOCK#")) {
          lock.results = globalThis.structuredClone(values[":results"]);
        } else {
          finalWrites.push(update);
          task.appActionResults = globalThis.structuredClone(
            values[":results"],
          );
        }
      }
      return {};
    }
    throw new Error("Unexpected command");
  });
});
it("files in the background, persists the result, and skips duplicate delivery", async () => {
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
  expect(job.status).toBe("complete");
  expect(task.status).toBe("open");
  expect(task.appActionResults[0].payload.tickets[0].srNum).toBe("123");
  expect(finalWrites[0].ConditionExpression).toContain("#status = :status");
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
});
it("closes an informational ticket if the user finishes while filing is running", async () => {
  execute
    .mockImplementationOnce(async (_actions, options) => {
      await options.onCheckpoint(ticket);
      task.status = "completed";
      task.completionMethod = "manual";
      task.userNote = "User change must survive";
      return [ticket];
    })
    .mockResolvedValueOnce([
      {
        code: "close_311_ticket",
        status: "submitted",
        payload: {
          closures: [{ serviceCode: "code", srNum: "123", status: "closed" }],
        },
      },
    ]);
  await runJob(message);
  expect(execute.mock.calls[1][0][0].code).toBe("close_311_ticket");
  expect(task.userNote).toBe("User change must survive");
  expect(task.status).toBe("completed");
  expect(task.appActionResults.map((/** @type {any} */ r) => r.code)).toEqual([
    "create_311_ticket",
    "close_311_ticket",
  ]);
});
it("finishes a replayed closure job without creating its ticket again", async () => {
  task.status = "completed";
  task.completionMethod = "manual";
  const failed = {
    code: "close_311_ticket",
    status: "failed",
    payload: {
      closures: [
        {
          serviceCode: "code",
          srNum: "123",
          status: "failed",
          reason: "sf311_closure_state_unknown",
        },
      ],
    },
  };
  job = { status: "retry", results: [ticket, failed] };
  task.appActionResults = [ticket, failed];
  execute.mockResolvedValueOnce([
    {
      code: "close_311_ticket",
      status: "submitted",
      payload: {
        closures: [{ serviceCode: "code", srNum: "123", status: "closed" }],
      },
    },
  ]);
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0]).toEqual([
    { code: "close_311_ticket", payload: {} },
  ]);
  expect(job.status).toBe("complete");
  expect(task.appActionResults[0].payload.tickets[0].srNum).toBe("123");
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
});

it("does not close tickets filed explicitly for City-owned work", async () => {
  task.status = "completed";
  task.completionMethod = "311_filed";
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
});
it("retries failures with the durable ticket checkpoint instead of forgetting the ticket", async () => {
  execute.mockImplementationOnce(async (_actions, options) => {
    await options.onCheckpoint(ticket);
    return [
      {
        code: "create_311_ticket",
        status: "failed",
        reason: "attachment_failure",
        payload: {},
      },
    ];
  });
  await expect(runJob(message)).rejects.toThrow(
    "retry from durable checkpoint",
  );
  expect(job.status).toBe("retry");
  await runJob(message);
  expect(
    execute.mock.calls[1][1].priorResults[0].payload.tickets[0].srNum,
  ).toBe("123");
  expect(job.status).toBe("complete");
});
it("does not start external work when another executor holds the lease", async () => {
  const mock = send.getMockImplementation();
  send.mockImplementation(async (command) => {
    if (command instanceof UpdateCommand)
      throw Object.assign(new Error("leased"), {
        name: "ConditionalCheckFailedException",
      });
    return mock?.(command);
  });
  await expect(runJob(message)).rejects.toThrow("leased");
  expect(execute).not.toHaveBeenCalled();
});
it("shares durable tickets between jobs even if a foreground task replacement loses integration fields", async () => {
  await runJob(message);
  task.appActionResults = [];
  job = { status: "dispatched" };
  await runJob({ ...message, jobSk: "SF311_JOB#task#edited" });
  expect(execute).toHaveBeenCalledOnce();
  expect(task.appActionResults[0].payload.tickets[0].srNum).toBe("123");
});
it("does not let an older pending checkpoint erase a confirmed ticket", () => {
  const merged = mergeBackgroundResult([ticket], {
    code: "create_311_ticket",
    status: "partial",
    recordedAt: "2026-10-26T12:00:00Z",
    payload: { tickets: [{ serviceCode: "code", creationState: "pending" }] },
  });
  expect(/** @type {any} */ (merged[0]).payload.tickets[0].srNum).toBe("123");
});

/** @param {string} [count] */
const deliver = (count = "1") =>
  handler(
    /** @type {import("aws-lambda").SQSEvent} */ ({
      Records: [
        {
          messageId: "message",
          body: JSON.stringify(message),
          receiptHandle: "receipt",
          attributes: { ApproximateReceiveCount: count },
        },
      ],
    }),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );

it.each([
  ["1", 30],
  ["2", 60],
  ["3", 120],
  ["4", 240],
  ["5", 480],
  ["6", 900],
  ["100000", 900],
  ["garbage", 30],
  ["0", 30],
  ["1.5", 30],
])("backs off receive count %s to %s seconds", (count, expected) => {
  expect(retryDelaySeconds(count)).toBe(expected);
});

it("delays transient failures without acknowledging them", async () => {
  execute.mockRejectedValue(new Error("City unavailable"));
  await expect(deliver("3")).rejects.toThrow("City unavailable");
  expect(sendSqs.mock.calls[0][0].input).toEqual({
    QueueUrl: "queue",
    ReceiptHandle: "receipt",
    VisibilityTimeout: 120,
  });
});

it.each([
  ["arn:aws:sqs:us-west-2:ACCOUNT_ID:311", "https://sqs.example/311"],
  ["arn:aws:sqs:us-west-2:ACCOUNT_ID:submissions", "queue"],
])(
  "backs off a receipt on its actual source queue: %s",
  async (eventSourceARN, expectedQueue) => {
    execute.mockRejectedValue(new Error("Transient failure"));
    await expect(
      handler(
        /** @type {any} */ ({
          Records: [
            {
              eventSourceARN,
              messageId: "message",
              body: JSON.stringify(message),
              receiptHandle: "receipt",
              attributes: { ApproximateReceiveCount: "2" },
            },
          ],
        }),
        /** @type {any} */ ({}),
        () => {},
      ),
    ).rejects.toThrow("Transient failure");
    expect(sendSqs.mock.calls[0][0].input).toMatchObject({
      QueueUrl: expectedQueue,
      ReceiptHandle: "receipt",
      VisibilityTimeout: 60,
    });
  },
);

it("reports exhausted closure reconciliation once per action with its durable job ID", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  task.status = "completed";
  task.completionMethod = "manual";
  task.appActionResults = [ticket];
  execute.mockResolvedValue([
    {
      code: "close_311_ticket",
      status: "failed",
      payload: {
        closures: [{ status: "failed", reason: "sf311_closure_state_unknown" }],
      },
    },
  ]);
  try {
    await expect(deliver("5")).rejects.toThrow("retry from durable checkpoint");
    const failures = log.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.marker === "Sf311ActionFailure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      Operation: "close",
      jobId: message.jobSk,
      attempt: 5,
      Sf311ReconciliationBlocked: 1,
      Sf311ActionFailed: 0,
    });
    expect(job.status).toBe("retry");
  } finally {
    log.mockRestore();
  }
});

it("alerts on a permanent failure even though the job is acknowledged", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  execute.mockResolvedValue([
    { code: "create_311_ticket", status: "failed", reason: "missing_location" },
  ]);
  try {
    await deliver();
    expect(job.status).toBe("failed");
    expect(sendSqs).not.toHaveBeenCalled();
    expect(
      log.mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toContainEqual(
      expect.objectContaining({
        Operation: "create",
        Sf311ActionFailed: 1,
        outcome: "needs_attention",
      }),
    );
  } finally {
    log.mockRestore();
  }
});

it("waits for a competing worker lease before retrying", async () => {
  lock.sf311LeaseExpiresAt = new Date(Date.now() + 300_000).toISOString();
  const original = send.getMockImplementation();
  send.mockImplementation(async (command) => {
    if (command instanceof UpdateCommand)
      throw Object.assign(new Error("leased"), {
        name: "ConditionalCheckFailedException",
      });
    return original?.(command);
  });
  await expect(deliver()).rejects.toThrow("leased");
  expect(
    sendSqs.mock.calls[0][0].input.VisibilityTimeout,
  ).toBeGreaterThanOrEqual(300);
  expect(execute).not.toHaveBeenCalled();
});

it("retries rather than acknowledging if the visibility update fails", async () => {
  execute.mockRejectedValue(new Error("City unavailable"));
  sendSqs.mockRejectedValue(new Error("SQS unavailable"));
  await expect(deliver()).rejects.toThrow("SQS unavailable");
  expect(job.status).not.toBe("complete");
});

it.each(["missing_location", "insufficient_classifier_information"])(
  "persists terminal %s and skips duplicate delivery, but permits a new edited job",
  async (reason) => {
    execute.mockResolvedValue([
      { ...ticket, status: "failed", reason, payload: {} },
    ]);
    await deliver();
    expect(job.status).toBe("failed");
    expect(task.appActionResults[0].reason).toBe(reason);
    await deliver();
    expect(execute).toHaveBeenCalledOnce();
    expect(sendSqs).not.toHaveBeenCalled();
    job = { status: "dispatched" };
    execute.mockResolvedValue([ticket]);
    await runJob({ ...message, jobSk: "SF311_JOB#task#edited" });
    expect(job.status).toBe("complete");
  },
);

it.each([
  "sf311_creation_uncertain_requires_reconciliation",
  "sf311_attachment_uncertain_requires_reconciliation",
])("keeps uncertain %s eligible for reconciliation", async (reason) => {
  execute.mockResolvedValue([{ ...ticket, status: "failed", reason }]);
  await expect(deliver()).rejects.toThrow("retry from durable checkpoint");
  expect(job.status).toBe("retry");
  expect(job.results[0].payload.tickets[0].srNum).toBe("123");
});

it("does not terminate a job containing both permanent and transient failures", async () => {
  execute.mockResolvedValue([
    { ...ticket, status: "failed", reason: "missing_location", payload: {} },
    {
      ...ticket,
      code: "close_311_ticket",
      status: "failed",
      reason: "City unavailable",
    },
  ]);
  await expect(deliver()).rejects.toThrow("retry from durable checkpoint");
  expect(job.status).toBe("retry");
});

it("backs off a final transaction conflict and retains the durable ticket", async () => {
  const original = send.getMockImplementation();
  send.mockImplementation(async (command) => {
    if (
      command instanceof TransactWriteCommand &&
      command.input.TransactItems?.some((entry) => entry.ConditionCheck)
    )
      throw new Error("TransactionCanceledException");
    return original?.(command);
  });
  await expect(deliver("2")).rejects.toThrow("TransactionCanceledException");
  expect(lock.results[0].payload.tickets[0].srNum).toBe("123");
  expect(sendSqs.mock.calls[0][0].input.VisibilityTimeout).toBe(60);
  expect(job.status).toBe("dispatched");
});

describe("tapped filing jobs (trigger: user_confirmed)", () => {
  const filedMessage = { ...message, jobSk: "SF311_JOB#task#filed-1" };
  /** @param {Record<string, unknown>} result */
  const filing = (result) => ({
    code: "create_311_ticket",
    recordedAt: "2026-10-26T12:00:00Z",
    payload: {},
    ...result,
  });
  /**
   * The worker's final transaction.
   * @returns {any[]}
   */
  const finalTransaction = () =>
    /** @type {any} */ (
      send.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof TransactWriteCommand)
        .at(-1)
    ).input.TransactItems;
  /** Attribute → value from a SET built with #aN/:aN placeholders. */
  const taskSet = () => {
    const update = finalWrites.at(-1);
    /** @type {Record<string, unknown>} */
    const set = {};
    for (const [name, attribute] of Object.entries(
      update.ExpressionAttributeNames,
    )) {
      const value = update.ExpressionAttributeValues[name.replace("#", ":")];
      if (name.startsWith("#a")) set[/** @type {string} */ (attribute)] = value;
    }
    return set;
  };

  beforeEach(() => {
    job = {
      status: "dispatched",
      trigger: "user_confirmed",
      actorId: "user-1",
    };
    task = {
      ...task,
      status: "in_progress",
      kind: "escalation",
      severity: 3,
      canBeInProgress: false,
      inProgressActionKind: "311_filed",
      appActionStatus: "queued",
      appActions: [
        {
          code: "create_311_ticket",
          payload: { executionTrigger: "user_confirmed" },
        },
      ],
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("runs user-confirmed actions even when global silent filing is disabled", async () => {
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) =>
      command instanceof GetCommand &&
      command.input.Key?.pk === "SYSTEM#CONTROLS"
        ? { Item: { enabled: false } }
        : original?.(command),
    );
    await runJob(filedMessage);

    expect(execute.mock.calls[0][1]).toMatchObject({
      trigger: "user_confirmed",
    });
    expect(taskSet()).toMatchObject({
      status: "completed",
      completionMethod: "311_filed",
      appActionStatus: "submitted",
      latestUpdateLabel: "311 ticket filed",
      gsi2pk: "SITE#site#TASK#completed",
    });
    expect(finalWrites.at(-1).ConditionExpression).toContain(
      "appActionStatus = :queued",
    );
    const timeline = /** @type {any} */ (
      finalTransaction().find(
        (entry) => entry.Put?.Item.entityType === "task_update",
      )
    );
    expect(timeline.Put.Item).toMatchObject({
      type: "311_ticket_filed",
      actorId: "user-1",
      documentationState: "open_for_documentation",
    });
    expect(job.status).toBe("complete");
  });

  it("keeps a task that can be in progress in progress once filed", async () => {
    task.canBeInProgress = true;

    await runJob(filedMessage);

    expect(taskSet()).not.toHaveProperty("status");
    expect(taskSet()).toMatchObject({ appActionStatus: "submitted" });
  });

  it("goes back to queued and throws for a retryable failure", async () => {
    execute.mockResolvedValueOnce([
      filing({ status: "failed", reason: "sf311_timeout" }),
    ]);

    await expect(runJob(filedMessage, { receiveCount: 2 })).rejects.toThrow(
      "retry",
    );
    expect(taskSet()).toMatchObject({ appActionStatus: "queued" });
    expect(job.status).toBe("retry");
  });

  it("marks the filing failed on the last delivery", async () => {
    execute.mockResolvedValueOnce([
      filing({ status: "failed", reason: "sf311_timeout" }),
    ]);

    await runJob(filedMessage, { receiveCount: 5 });

    expect(taskSet()).toMatchObject({ appActionStatus: "failed" });
    expect(taskSet()).not.toHaveProperty("status");
    expect(job.status).toBe("failed");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"eventType":"311_app_action_failed"'),
    );
  });

  it("alarms on an acknowledged filing with no action result", async () => {
    execute.mockResolvedValueOnce([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runJob(filedMessage);
      expect(job.status).toBe("failed");
      expect(taskSet()).toMatchObject({ appActionStatus: "failed" });
      const events = log.mock.calls.map(([line]) => JSON.parse(line));
      expect(
        events.filter((event) => event.marker === "Sf311ActionFailure"),
      ).toEqual([
        expect.objectContaining({
          Operation: "create",
          Sf311ActionFailed: 1,
          reason: "app_action_failed",
        }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    "missing_location",
    "sf311_creation_uncertain_requires_reconciliation",
  ])("does not retry %s", async (reason) => {
    execute.mockResolvedValueOnce([filing({ status: "failed", reason })]);

    await runJob(filedMessage, { receiveCount: 1 });

    expect(taskSet()).toMatchObject({ appActionStatus: "failed" });
    expect(job.status).toBe("failed");
  });

  it("skips a task that is no longer waiting to file", async () => {
    task.status = "completed";

    await runJob(filedMessage);

    expect(execute).not.toHaveBeenCalled();
    expect(finalWrites).toEqual([]);
    const abandon = /** @type {any} */ (
      send.mock.calls
        .map(([command]) => command)
        .find(
          (command) =>
            command instanceof UpdateCommand &&
            command.input.Key?.sk === filedMessage.jobSk,
        )
    );
    expect(abandon.input.ExpressionAttributeValues[":status"]).toBe(
      "abandoned",
    );
  });

  it("passes the SQS receive count through the handler", async () => {
    execute.mockResolvedValueOnce([
      filing({ status: "failed", reason: "sf311_timeout" }),
    ]);

    await handler(
      /** @type {any} */ ({
        Records: [
          {
            body: JSON.stringify(filedMessage),
            receiptHandle: "rh",
            attributes: { ApproximateReceiveCount: "5" },
          },
        ],
      }),
      /** @type {any} */ ({}),
      () => {},
    );

    expect(job.status).toBe("failed");
    expect(sendSqs).not.toHaveBeenCalled();
  });
});

it.each([
  { enabled: false },
  { enabled: true, epochStartedAt: "2026-10-30T12:00:00Z" },
])(
  "consumes disabled or old silent work without filing or closing: %j",
  async (control) => {
    task.createdAt = "2026-10-29T12:00:00Z";
    task.status = "completed";
    task.appActionResults = [ticket];
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) =>
      command instanceof GetCommand &&
      command.input.Key?.pk === "SYSTEM#CONTROLS"
        ? { Item: control }
        : original?.(command),
    );
    await runJob(message);
    expect(execute).not.toHaveBeenCalled();
    expect(
      send.mock.calls.some(
        ([command]) =>
          command instanceof UpdateCommand &&
          command.input.Key?.sk === message.jobSk &&
          command.input.ExpressionAttributeValues?.[":reason"] ===
            "silent_filing_disabled",
      ),
    ).toBe(true);
    expect(finalWrites).toHaveLength(0);
  },
);

it("preserves silent and deliberate tickets with the same service code through worker checkpoints", () => {
  const silent = {
    code: "create_311_ticket",
    status: "submitted",
    recordedAt: "2026-11-01T12:00:00Z",
    payload: {
      executionTrigger: "task_created",
      tickets: [
        { serviceCode: "same-service", srNum: "111", responsibleAgency: "76" },
      ],
    },
  };
  const deliberate = {
    code: "create_311_ticket",
    status: "submitted",
    recordedAt: "2026-11-01T12:01:00Z",
    payload: {
      executionTrigger: "user_confirmed",
      tickets: [
        { serviceCode: "same-service", srNum: "222", responsibleAgency: "99" },
      ],
    },
  };
  const both = mergeBackgroundResult([silent], deliberate);
  expect(both).toEqual([deliberate, silent]);
  expect(mergeBackgroundResult(both, deliberate)).toEqual(both);
  expect(mergeBackgroundResult(both, silent)).toEqual(both);
});

it("an older silent job preserves a queued deliberate filing status", async () => {
  task.status = "in_progress";
  task.inProgressActionKind = "311_filed";
  task.appActionStatus = "queued";
  task.appActionResults = [ticket];
  lock.results = [ticket];
  await runJob(message);
  expect(finalWrites.at(-1).ExpressionAttributeValues[":actionStatus"]).toBe(
    "queued",
  );
  expect(finalWrites.at(-1).ConditionExpression).toContain(
    "appActionStatus = :priorStatus",
  );
  expect(finalWrites.at(-1).ExpressionAttributeValues[":priorStatus"]).toBe(
    "queued",
  );
});

it.each(["submitted", "failed"])(
  "settles an obsolete rejected silent attempt while deliberate filing is %s",
  async (status) => {
    task.status = "in_progress";
    task.inProgressActionKind = "311_filed";
    task.appActionStatus = status;
    task.appActions = [
      {
        code: "create_311_ticket",
        payload: { executionTrigger: "user_confirmed" },
      },
    ];
    const rejected = {
      code: "create_311_ticket",
      status: "failed",
      reason: "21",
      recordedAt: ticket.recordedAt,
      payload: {
        executionTrigger: "task_created",
        responsibleAgencyCode: "76",
        tickets: [
          {
            serviceCode: "code",
            responsibleAgency: "76",
            creationState: "rejected",
          },
        ],
      },
    };
    const deliberate = {
      ...ticket,
      status,
      payload: { ...ticket.payload, executionTrigger: "user_confirmed" },
    };
    task.appActionResults = [deliberate, rejected];
    lock.results = [deliberate, rejected];
    job.results = [rejected];
    execute.mockResolvedValue([]);
    await expect(runJob(message)).resolves.toBeUndefined();
    expect(job.status).toBe("complete");
    expect(task.appActionResults).toEqual([deliberate, rejected]);
    expect(lock.results).toEqual([deliberate, rejected]);
    expect(finalWrites.at(-1).ExpressionAttributeValues[":actionStatus"]).toBe(
      status,
    );
  },
);

it("keeps an obsolete uncertain silent outcome pending for reconciliation", async () => {
  task.appActions = [
    {
      code: "create_311_ticket",
      payload: { executionTrigger: "user_confirmed" },
    },
  ];
  const uncertain = {
    code: "create_311_ticket",
    status: "failed",
    reason: "sf311_creation_uncertain_requires_reconciliation",
    recordedAt: ticket.recordedAt,
    payload: {
      executionTrigger: "task_created",
      responsibleAgencyCode: "76",
      tickets: [
        {
          serviceCode: "code",
          responsibleAgency: "76",
          creationState: "pending",
        },
      ],
    },
  };
  task.appActionResults = [uncertain];
  lock.results = [uncertain];
  execute.mockResolvedValue([]);
  await expect(runJob(message)).rejects.toThrow(
    "retry from durable checkpoint",
  );
  expect(job.status).toBe("retry");
  expect(task.appActionResults).toEqual([uncertain]);
});

it("files a replacement silent service once and retains both tickets for closure", async () => {
  const old = {
    ...ticket,
    payload: {
      ...ticket.payload,
      executionTrigger: "task_created",
      serviceCodeOrAction: "old",
      tickets: [{ serviceCode: "old", srNum: "111", responsibleAgency: "76" }],
    },
  };
  const next = {
    ...ticket,
    payload: {
      ...ticket.payload,
      executionTrigger: "task_created",
      serviceCodeOrAction: "new",
      tickets: [{ serviceCode: "new", srNum: "222", responsibleAgency: "76" }],
    },
  };
  task.appActionResults = [old];
  task.appActions[0].payload.serviceCodeOrAction = "new";
  lock.results = [old];
  execute.mockResolvedValue([next]);
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
  expect(task.appActionResults).toEqual([old, next]);
  job.status = "dispatched";
  await runJob(message);
  expect(execute).toHaveBeenCalledOnce();
  task.status = "completed";
  task.completionMethod = "manual";
  job.status = "dispatched";
  execute.mockResolvedValue([]);
  await runJob(message);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1][0][0].code).toBe("close_311_ticket");
  expect(execute.mock.calls[1][1].priorResults).toEqual([old, next]);
});
