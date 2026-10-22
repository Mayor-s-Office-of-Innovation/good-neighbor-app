import { afterEach, expect, it, vi } from "vitest";
import { analysisRevision } from "../src/analysis/duplicates/jobs.js";
const state = vi.hoisted(() => ({ rows: [], analysis: {}, send: vi.fn() }));
vi.mock("../src/db.js", () => ({
  ddb: {
    send: async (cmd) =>
      cmd.input.Key ? { Item: state.analysis } : { Items: state.rows },
  },
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = state.send;
  },
  SendMessageCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function run(apply) {
  vi.resetModules();
  state.send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.stubEnv("DUPLICATE_QUEUE_URL", "queue");
  process.argv = [
    "node",
    "recover",
    "--site",
    "site",
    ...(apply ? ["--apply"] : []),
  ];
  state.analysis = {
    status: "analyzed",
    analysisId: "a",
    analyzedAt: new Date().toISOString(),
    concerns: [],
  };
  const sk = `DUP_RESULT#check:photo#${analysisRevision(state.analysis)}`;
  state.rows = [
    { sk, status: "pending" },
    {
      sk,
      status: "evaluated",
      conditionResults: [{ assessmentOutcome: "no_match_with_failures" }],
    },
    {
      sk,
      status: "evaluated",
      conditionResults: [{ assessmentOutcome: "assessed_no_match" }],
    },
    { sk: "DUP_RESULT#check:photo#old-revision", status: "pending" },
  ];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./recover-duplicate-checks.mjs");
  return log;
}
it("dry-runs current failed/incomplete results without touching SQS", async () => {
  const log = await run(false);
  expect(state.send).not.toHaveBeenCalled();
  expect(JSON.parse(log.mock.calls.at(-1)[0])).toEqual({
    selected: 2,
    skipped: 1,
    applied: false,
  });
});
it("only enqueues selected revisions when explicitly applied", async () => {
  await run(true);
  expect(state.send).toHaveBeenCalledTimes(2);
  expect(
    JSON.parse(state.send.mock.calls[0][0].input.MessageBody),
  ).toMatchObject({ siteId: "site", checkId: "check", artifactId: "photo" });
});
