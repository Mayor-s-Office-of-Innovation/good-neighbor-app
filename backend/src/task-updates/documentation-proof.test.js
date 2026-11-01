import { beforeEach, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { writeDocumentedUpdate } from "./task-update-store.js";

beforeEach(() => send.mockReset());
it.each([
  "later-note",
  "concurrent-note",
  "newer-resolution",
  "existing-proof",
  "empty",
])("saves resolution documentation safely: %s", async (kind) => {
  const update = {
    pk: "SITE#site",
    sk: "TASKUPDATE#task#old#resolution",
    taskId: "task",
    updateId: "resolution",
    type: "issue_resolved",
    occurredAt: "2026-11-01T12:00:00Z",
    documentedAt: "2026-11-01T12:05:00Z",
    documentationState: "closed",
    notes: kind === "empty" ? [] : ["Cleaned"],
    photoKeys: [],
  };
  const task = {
    pk: "SITE#site",
    sk: "TASK#task",
    taskId: "task",
    kind: "action",
    status: "completed",
    completedAt:
      kind === "newer-resolution" ? "2026-11-01T12:04:00Z" : update.occurredAt,
    updatedAt: "2026-11-01T12:03:00Z",
    latestUpdateId: "later-note",
    latestUpdateLabel: "Resolved",
    proofAddedAt: kind === "existing-proof" ? "2026-11-01T12:02:00Z" : null,
  };
  let conflict = kind === "concurrent-note";
  send.mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: { ...task } };
    if (command instanceof TransactWriteCommand && conflict) {
      conflict = false;
      task.latestUpdateId = "concurrent-note";
      task.updatedAt = "2026-11-01T12:04:00Z";
      throw Object.assign(new Error("task changed"), {
        name: "TransactionCanceledException",
      });
    }
    return {};
  });
  await writeDocumentedUpdate("table", update);
  const writes = send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof TransactWriteCommand);
  expect(writes).toHaveLength(kind === "concurrent-note" ? 2 : 1);
  const tx = /** @type {any[]} */ (writes.at(-1)?.input.TransactItems || []);
  expect(tx[0].Put.Item).toEqual(update);
  if (["later-note", "concurrent-note"].includes(kind)) {
    expect(tx).toHaveLength(2);
    expect(tx[1].Update.ExpressionAttributeValues).toMatchObject({
      ":proof": update.documentedAt,
      ":prior": task.updatedAt,
      ":completed": "completed",
    });
    expect(tx[1].Update.UpdateExpression).not.toContain("latestUpdateId");
  } else expect(tx).toHaveLength(1);
});
