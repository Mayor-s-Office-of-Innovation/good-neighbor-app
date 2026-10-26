import { beforeEach, expect, it, vi } from "vitest";
import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
const { send, execute } = vi.hoisted(() => ({
  send: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({ getConfig: () => ({ dynamoTable: "test" }) }));
vi.mock("../analysis/guidance/app-actions.js", async (original) => ({
  ...(await original()),
  executeAppActions: execute,
}));
const { runJob, mergeBackgroundResult } = await import("./automatic-311.js");
const message = {
  siteId: "site",
  taskId: "task",
  jobPk: "SITE#site",
  jobSk: "AUTO311_JOB#task#created",
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
  lock = {};
  job = { status: "dispatched" };
  finalWrites = [];
  execute.mockReset().mockResolvedValue([ticket]);
  send.mockReset().mockImplementation(async (command) => {
    const input = command.input;
    if (command instanceof GetCommand)
      return {
        Item: globalThis.structuredClone(
          input.Key.sk.startsWith("AUTO311_JOB#")
            ? job
            : input.Key.sk.startsWith("AUTO311_LOCK#")
              ? lock
              : task,
        ),
      };
    if (command instanceof UpdateCommand) {
      if (input.UpdateExpression.startsWith("SET auto311Lease")) {
        lock.auto311Lease = input.ExpressionAttributeValues[":token"];
        return { Attributes: globalThis.structuredClone(lock) };
      }
      delete lock.auto311Lease;
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      for (const entry of input.TransactItems) {
        if (!entry.Update) continue;
        const update = entry.Update,
          values = update.ExpressionAttributeValues;
        if (update.Key.sk.startsWith("AUTO311_JOB#")) {
          job.results = globalThis.structuredClone(values[":results"]);
          if (values[":status"]) job.status = values[":status"];
        } else if (update.Key.sk.startsWith("AUTO311_LOCK#")) {
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
  await runJob({ ...message, jobSk: "AUTO311_JOB#task#edited" });
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
