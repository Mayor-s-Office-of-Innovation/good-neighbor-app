import { afterEach, expect, it, vi } from "vitest";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
const send = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ ddb: { send } }));
const originalArgs = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("paginates CHECK and TASK families independently even when a filtered page is empty", async () => {
  vi.resetModules();
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  process.argv = ["node", "backfill-thumbnails.mjs", "--site", "site"];
  const cursor = { pk: "SITE#site", sk: "CHECK#cursor" };
  send
    .mockReset()
    .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import("../../scripts/backfill-thumbnails.mjs");
  expect(send).toHaveBeenCalledTimes(3);
  const commands = send.mock.calls.map(([command]) => command);
  expect(commands.every((command) => command instanceof QueryCommand)).toBe(
    true,
  );
  expect(
    commands.map(
      (command) => command.input.ExpressionAttributeValues[":prefix"],
    ),
  ).toEqual(["CHECK#", "CHECK#", "TASK#"]);
  expect(commands[0].input.KeyConditionExpression).toContain(
    "begins_with(#sk, :prefix)",
  );
  expect(commands[1].input.ExclusiveStartKey).toEqual(cursor);
  expect(commands[2].input.ExclusiveStartKey).toBeUndefined();
});
it("keeps the unscoped dry-run scan", async () => {
  vi.resetModules();
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  process.argv = ["node", "backfill-thumbnails.mjs"];
  send.mockReset().mockResolvedValueOnce({ Items: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import("../../scripts/backfill-thumbnails.mjs");
  expect(send.mock.calls[0][0]).toBeInstanceOf(ScanCommand);
});
