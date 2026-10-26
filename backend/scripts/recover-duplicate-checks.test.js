import { afterEach, expect, it, vi } from "vitest";
import { analysisRevision } from "../src/analysis/duplicates/jobs.js";
const state = vi.hoisted(() => ({
  rows: [],
  analysis: {},
  send: vi.fn(),
  updates: [],
  updateError: null,
}));
vi.mock("../src/db.js", () => ({
  ddb: {
    send: async (cmd) => {
      if (cmd.input.UpdateExpression) {
        state.updates.push(cmd.input);
        if (state.updateError) throw state.updateError;
        return {};
      }
      return cmd.input.Key ? { Item: state.analysis } : { Items: state.rows };
    },
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
async function run(apply, updateError = null, recoveryCase = null, ageMs = 0) {
  state.updates = [];
  state.updateError = updateError;
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
    analyzedAt: new Date(Date.now() - ageMs).toISOString(),
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
  if (recoveryCase)
    state.rows = [
      { sk, ...recoveryCase },
      { sk: "DUP_RESULT#check:photo#old-revision", ...recoveryCase },
    ];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./recover-duplicate-checks.mjs");
  return log;
}
it("dry-runs current failed/incomplete results without touching SQS", async () => {
  const log = await run(false);
  expect(state.send).not.toHaveBeenCalled();
  expect(state.updates).toHaveLength(0);
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

it("records one stable recovery timestamp without replacing result fields", async () => {
  await run(true);
  expect(state.updates).toHaveLength(2);
  const sent = JSON.parse(state.send.mock.calls[0][0].input.MessageBody);
  expect(state.updates[0]).toMatchObject({
    UpdateExpression: "SET recoveryRequestedAt = :time",
    ConditionExpression:
      "#status = :status AND attribute_not_exists(evaluatedAt)",
    ExpressionAttributeValues: {
      ":time": sent.enqueuedAt,
      ":status": "pending",
    },
  });
});
it("leaves concurrent completed results untouched", async () => {
  await run(
    true,
    Object.assign(new Error("race"), {
      name: "ConditionalCheckFailedException",
    }),
  );
  expect(state.send).toHaveBeenCalledTimes(2);
});

it.each([
  { status: "incomplete" },
  {
    status: "evaluated",
    conditionResults: [{ assessmentOutcome: "incomplete" }],
  },
])(
  "dry-runs and applies new incomplete recovery markers: %j",
  async (recoveryCase) => {
    const log = await run(false, null, recoveryCase);
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toEqual({
      selected: 1,
      skipped: 1,
      applied: false,
    });
    expect(state.send).not.toHaveBeenCalled();
    await run(true, null, recoveryCase);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].ExpressionAttributeValues[":status"]).toBe(
      recoveryCase.status,
    );
  },
);
it("does not revive expired incomplete evidence", async () => {
  const log = await run(false, null, { status: "incomplete" }, 31 * 86400000);
  expect(JSON.parse(log.mock.calls.at(-1)[0])).toEqual({
    selected: 0,
    skipped: 2,
    applied: false,
  });
  expect(state.send).not.toHaveBeenCalled();
});
