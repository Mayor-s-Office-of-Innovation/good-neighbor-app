import { beforeEach, expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../db.js", () => ({ ddb: { send } }));
import { retractEvidenceTasks } from "./evidence-deletion.js";
const input = {
  tableName: "table",
  siteId: "site",
  checkId: "check",
  artifactId: "photo",
};
const task = {
  pk: "SITE#site",
  sk: "TASK#unused",
  taskId: "unused",
  status: "open",
  kind: "action",
  sourceArtifactIds: ["photo"],
  updatedAt: "before",
};
beforeEach(() => send.mockReset().mockResolvedValue({}));

it("retracts only solely-supported unused tasks and reads every page consistently", async () => {
  send.mockResolvedValueOnce({
    Items: [
      task,
      { ...task, taskId: "acted", status: "in_progress" },
      { ...task, taskId: "shared", sourceArtifactIds: ["photo", "other"] },
      { ...task, taskId: "noted", latestUpdateId: "note" },
    ],
    LastEvaluatedKey: { pk: "SITE#site", sk: "TASK#unused" },
  });
  send.mockResolvedValueOnce({
    Items: [{ ...task, sk: "TASK#second", taskId: "second" }],
  });
  await retractEvidenceTasks(input);
  const queries = send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof QueryCommand);
  expect(queries).toHaveLength(2);
  expect(queries.every((command) => command.input.ConsistentRead)).toBe(true);
  const writes = send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand);
  expect(
    writes.map((command) => command.input.TransactItems?.[0].Put?.Item?.taskId),
  ).toEqual(["unused", "second"]);
  expect(writes[0].input.TransactItems?.[0].Put).toMatchObject({
    Item: { status: "superseded", supersessionReason: "evidence_deleted" },
    ExpressionAttributeValues: { ":version": "before" },
  });
});

it("preserves a task acted on concurrently with evidence removal", async () => {
  send.mockResolvedValueOnce({ Items: [task] });
  send.mockResolvedValueOnce({}); // no worker lease/checkpoint
  send.mockRejectedValueOnce(
    Object.assign(new Error("changed"), {
      name: "TransactionCanceledException",
    }),
  );
  send.mockResolvedValueOnce({
    Item: { ...task, status: "completed", updatedAt: "after" },
  });
  await retractEvidenceTasks(input);
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls[3][0]).toBeInstanceOf(GetCommand);
  expect(send.mock.calls[3][0].input.ConsistentRead).toBe(true);
});

it("does not report cleanup success when persistence fails", async () => {
  send.mockResolvedValueOnce({ Items: [task] });
  send.mockResolvedValueOnce({});
  send.mockRejectedValueOnce(new Error("unavailable"));
  await expect(retractEvidenceTasks(input)).rejects.toThrow("unavailable");
});

it.each([
  { sf311Lease: "active", sf311LeaseExpiresAt: "2999-01-01T00:00:00.000Z" },
  { sf311Lease: "unknown" },
  {
    results: [
      {
        code: "create_311_ticket",
        status: "partial",
        reason: "creation_pending",
      },
    ],
  },
  { results: [{ code: "create_311_ticket", status: "submitted" }] },
])(
  "keeps cleanup pending for an active worker or unmerged external result: %j",
  async (lock) => {
    send.mockResolvedValueOnce({ Items: [task] });
    send.mockResolvedValueOnce({ Item: lock });
    await expect(retractEvidenceTasks(input)).rejects.toMatchObject({
      name: "EvidenceDeletionPending",
    });
    expect(
      send.mock.calls.some(([c]) => c instanceof TransactWriteCommand),
    ).toBe(false);
  },
);

it("rechecks the lease when a worker claims it during cleanup", async () => {
  send.mockResolvedValueOnce({ Items: [task] });
  send.mockResolvedValueOnce({});
  send.mockImplementationOnce(async (command) => {
    expect(command.input.TransactItems[1].ConditionCheck).toMatchObject({
      Key: { pk: task.pk, sk: "SF311_LOCK#unused" },
      ConditionExpression:
        "attribute_not_exists(sf311Lease) AND attribute_not_exists(results)",
    });
    throw Object.assign(new Error("worker claimed lease"), {
      name: "TransactionCanceledException",
    });
  });
  send.mockResolvedValueOnce({ Item: task });
  send.mockResolvedValueOnce({ Item: { sf311Lease: "new-worker" } });
  await expect(retractEvidenceTasks(input)).rejects.toMatchObject({
    name: "EvidenceDeletionPending",
  });
});

it("preserves a filed ticket when pending cleanup is retried after worker completion", async () => {
  send.mockResolvedValueOnce({ Items: [task] });
  send.mockResolvedValueOnce({ Item: { sf311Lease: "worker" } });
  await expect(retractEvidenceTasks(input)).rejects.toMatchObject({
    name: "EvidenceDeletionPending",
  });
  const filed = {
    ...task,
    appActionResults: [
      {
        code: "create_311_ticket",
        status: "submitted",
        externalId: "synthetic-ticket",
      },
    ],
  };
  send.mockResolvedValueOnce({ Items: [filed] });
  await retractEvidenceTasks(input);
  expect(send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(
    false,
  );
});

it("allows cleanup after a worker expires without external effects", async () => {
  send.mockResolvedValueOnce({ Items: [task] });
  send.mockResolvedValueOnce({
    Item: {
      sf311Lease: "expired",
      sf311LeaseExpiresAt: "2020-01-01T00:00:00.000Z",
    },
  });
  await retractEvidenceTasks(input);
  const write = send.mock.calls.find(
    ([c]) => c instanceof TransactWriteCommand,
  )?.[0];
  expect(write.input.TransactItems[0].Put.Item.status).toBe("superseded");
  expect(
    write.input.TransactItems[1].ConditionCheck.ExpressionAttributeValues,
  ).toMatchObject({ ":observedLease": "expired" });
});
