import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../db.js", () => ({ ddb: { send } }));

const { queue311Filing } = await import("./sf311-filing-queue.js");

const now = new Date("2026-08-18T12:02:00.000Z");

/** @param {Record<string, unknown>} [overrides] */
function task(overrides = {}) {
  return {
    pk: "SITE#site-1",
    sk: "TASK#task-1",
    taskId: "task-1",
    status: "open",
    kind: "escalation",
    severity: 3,
    canBeInProgress: false,
    ...overrides,
  };
}

/** @param {Record<string, unknown>} current */
function queue(current) {
  return queue311Filing({
    tableName: "table",
    siteId: "site-1",
    taskId: "task-1",
    task: current,
    actorId: "user-1",
    now,
  });
}

const cancelled = () =>
  Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
  });

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
});

describe("queue311Filing", () => {
  it("queues an open task and its SF311 job in one transaction", async () => {
    const result = await queue(task());

    expect(send).toHaveBeenCalledTimes(1);
    const tx = send.mock.calls[0][0];
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    const [taskPut, jobPut] = tx.input.TransactItems;
    expect(taskPut.Put.Item).toMatchObject({
      status: "in_progress",
      appActionStatus: "queued",
      inProgressActionKind: "311_filed",
      agency: "311",
      gsi2pk: "SITE#site-1#TASK#in_progress",
    });
    expect(taskPut.Put.ConditionExpression).toContain("#status = :open");
    expect(jobPut.Put.Item).toMatchObject({
      pk: "SITE#site-1",
      entityType: "SF311_OUTBOX",
      status: "pending",
      siteId: "site-1",
      taskId: "task-1",
      trigger: "user_confirmed",
      actorId: "user-1",
      createdAt: now.toISOString(),
    });
    expect(jobPut.Put.Item.sk).toMatch(/^SF311_JOB#task-1#filed-/);
    expect(jobPut.Put.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(result).toMatchObject({
      status: "in_progress",
      appActionStatus: "queued",
    });
  });

  it("queues a task stuck completing past its lease", async () => {
    await queue(
      task({
        status: "completing",
        completionLeaseExpiresAt: "2026-08-18T12:00:00.000Z",
      }),
    );

    const [taskPut] = send.mock.calls[0][0].input.TransactItems;
    expect(taskPut.Put.Item).toMatchObject({
      status: "in_progress",
      completionLeaseExpiresAt: null,
    });
  });

  it.each(["queued", "submitted"])(
    "returns the task unchanged on a repeat tap while %s",
    async (appActionStatus) => {
      const current = task({
        status: "in_progress",
        inProgressActionKind: "311_filed",
        appActionStatus,
      });

      await expect(queue(current)).resolves.toEqual(current);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("queues a new job for a failed filing (the retry button)", async () => {
    const result = await queue(
      task({
        status: "in_progress",
        inProgressActionKind: "311_filed",
        appActionStatus: "failed",
      }),
    );

    const [taskUpdate, jobPut] = send.mock.calls[0][0].input.TransactItems;
    expect(taskUpdate.Update.ConditionExpression).toContain(
      "appActionStatus = :failed",
    );
    expect(taskUpdate.Update.ExpressionAttributeValues[":queued"]).toBe(
      "queued",
    );
    expect(jobPut.Put.Item).toMatchObject({
      status: "pending",
      trigger: "user_confirmed",
    });
    expect(result).toMatchObject({
      status: "in_progress",
      appActionStatus: "queued",
    });
  });

  it("gives each tap its own job row", async () => {
    const failed = task({
      status: "in_progress",
      inProgressActionKind: "311_filed",
      appActionStatus: "failed",
    });
    await queue(task());
    await queue(failed);

    const firstJob = send.mock.calls[0][0].input.TransactItems[1].Put.Item;
    const retryJob = send.mock.calls[1][0].input.TransactItems[1].Put.Item;
    expect(retryJob.sk).not.toBe(firstJob.sk);
  });

  it("answers a lost race with the task the other tap queued", async () => {
    const queued = task({
      status: "in_progress",
      inProgressActionKind: "311_filed",
      appActionStatus: "queued",
    });
    send.mockRejectedValueOnce(cancelled());
    send.mockResolvedValueOnce({ Item: queued });

    await expect(queue(task())).resolves.toEqual(queued);
  });

  it("rethrows a lost race when the task did not end up queued", async () => {
    send.mockRejectedValueOnce(cancelled());
    send.mockResolvedValueOnce({ Item: task({ status: "completed" }) });

    await expect(queue(task())).rejects.toMatchObject({
      name: "TransactionCanceledException",
    });
  });

  it("rejects a task in progress for another reason", async () => {
    await expect(
      queue(task({ status: "in_progress", inProgressActionKind: "button" })),
    ).rejects.toMatchObject({ name: "TerminalConflict" });
    expect(send).not.toHaveBeenCalled();
  });
});
