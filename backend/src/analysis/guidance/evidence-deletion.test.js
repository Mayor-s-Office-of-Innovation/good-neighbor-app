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
  send.mockRejectedValueOnce(
    Object.assign(new Error("changed"), {
      name: "TransactionCanceledException",
    }),
  );
  send.mockResolvedValueOnce({
    Item: { ...task, status: "completed", updatedAt: "after" },
  });
  await retractEvidenceTasks(input);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2][0]).toBeInstanceOf(GetCommand);
  expect(send.mock.calls[2][0].input.ConsistentRead).toBe(true);
});

it("does not report cleanup success when persistence fails", async () => {
  send.mockResolvedValueOnce({ Items: [task] });
  send.mockRejectedValueOnce(new Error("unavailable"));
  await expect(retractEvidenceTasks(input)).rejects.toThrow("unavailable");
});
