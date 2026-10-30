import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeSf311Request,
  reportSf311Results,
  reportSf311Failure,
  logSf311JobError,
} from "./sf311-observability.js";
import { createSf311Client, Sf311Error } from "./sf311-client.js";

let log = vi.fn();
beforeEach(() => {
  log = vi.fn();
  vi.spyOn(console, "log").mockImplementation(log);
  vi.stubEnv("METRICS_NAMESPACE", "test-app");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const events = () => log.mock.calls.map(([line]) => JSON.parse(line));

it("preserves database failure identity and original frames without private error text", () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(
    new Error("private ticket\n    at forged (/var/task/private.js:1:2)"),
    {
      name: "ProvisionedThroughputExceededException",
      $metadata: { requestId: "synthetic-request", httpStatusCode: 400 },
      request: { Notes: "private payload" },
      body: "private response",
    },
  );
  const frame = "    at saveJob (file:///var/task/index.mjs:123:45)";
  const stack = `${error.name}: ${error.message}\n${frame}\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at fetch (https://example.test/private?token=private:1:2)`;
  error.stack = stack;
  logSf311JobError(error, { messageId: "message-1", attempt: 2 });
  expect(errorLog).toHaveBeenCalledOnce();
  const entry = JSON.parse(errorLog.mock.calls[0][0]);
  expect(entry).toMatchObject({
    integration: "sf311",
    eventType: "sf311_job_error",
    name: error.name,
    messageId: "message-1",
    attempt: 2,
    awsRequestId: "synthetic-request",
    httpStatus: 400,
  });
  expect(entry.stack).toContain(frame);
  expect(entry.stack).toContain("node:internal/process/task_queues:105:5");
  expect(JSON.stringify(entry)).not.toMatch(/private|forged|https:/);
  expect(error.stack).toBe(stack);
  expect(log).not.toHaveBeenCalled();
});

it.each(["private thrown value", { body: "private response" }, null])(
  "handles non-Error rejections without serializing them: %j",
  (error) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    logSf311JobError(error, { messageId: "message-1" });
    expect(JSON.parse(errorLog.mock.calls[0][0])).toMatchObject({
      name: "NonError",
      messageId: "message-1",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private");
  },
);

it("does not invent frames when the original error has no stack", () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("private");
  error.stack = undefined;
  logSf311JobError(error, { messageId: "message-1" });
  expect(JSON.parse(errorLog.mock.calls[0][0]).stack).toBe(
    "Error: 311 job attempt failed",
  );
});

it("does not throw when job diagnostic logging fails", () => {
  vi.spyOn(console, "error").mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  expect(() =>
    logSf311JobError(new Error("private"), { messageId: "message-1" }),
  ).not.toThrow();
});

it.each([
  [{ status: 401 }, "authentication"],
  [{ status: 403 }, "authentication"],
  [{ status: 429 }, "throttled"],
  [{ status: 503 }, "server"],
  [{ code: "sf311_timeout" }, "timeout"],
  [{ code: "sf311_network_error" }, "network"],
])(
  "classifies connection failures and preserves the original rejection: %j",
  async (details, category) => {
    const error = Object.assign(new Error("private narrative"), details, {
      body: { password: "private-test-value" },
    });
    await expect(
      observeSf311Request("status", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(events()[0]).toMatchObject({
      Operation: "status",
      category,
      Sf311Requests: 1,
      Sf311RequestFailures: 1,
      Sf311ConnectionFailed: 1,
    });
    expect(JSON.stringify(events())).not.toContain("private");
    expect(events()[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      [],
      ["Operation"],
    ]);
  },
);

it("keeps business validation failures separate from connectivity", async () => {
  await expect(
    observeSf311Request("create", async () => {
      throw new Sf311Error("private", { status: 200, code: "21" });
    }),
  ).rejects.toThrow("private");
  expect(events()[0]).toMatchObject({
    reason: "hub_21",
    Sf311RequestFailures: 1,
    Sf311ConnectionFailed: 0,
  });
});

it("records success without logging the response", async () => {
  const response = { private: "ticket narrative" };
  expect(await observeSf311Request("create", async () => response)).toBe(
    response,
  );
  expect(events()[0]).toMatchObject({
    outcome: "succeeded",
    Sf311RequestFailures: 0,
    Sf311ConnectionFailed: 0,
  });
  expect(JSON.stringify(events())).not.toContain("narrative");
});

it("reads nested closure reasons and pages only on terminal/exhausted failures", () => {
  const results = /** @type {any} */ ([
    {
      code: "close_311_ticket",
      status: "failed",
      payload: {
        closures: [
          {
            status: "failed",
            reason: "sf311_closure_state_unknown",
            srNum: "private-ticket",
          },
          { status: "failed", reason: "sf311_closure_state_unknown" },
        ],
      },
    },
  ]);
  reportSf311Results(results, {
    terminal: false,
    attempt: 1,
    jobId: "SF311_JOB#task#resolved",
  });
  reportSf311Results(results, {
    terminal: true,
    attempt: 5,
    jobId: "SF311_JOB#task#resolved",
  });
  expect(events()).toHaveLength(2);
  expect(events()[0]).toMatchObject({
    Operation: "close",
    Sf311ReconciliationBlocked: 0,
    Sf311ActionFailed: 0,
    outcome: "retrying",
  });
  expect(events()[1]).toMatchObject({
    Operation: "close",
    Sf311ReconciliationBlocked: 1,
    Sf311ActionFailed: 0,
    outcome: "needs_attention",
  });
  expect(JSON.stringify(events())).not.toContain("private-ticket");
});

it("reports acknowledged terminal action failures and rejects free-form telemetry", () => {
  reportSf311Results(
    /** @type {any} */ ([
      {
        code: "create_311_ticket",
        status: "failed",
        reason: "missing_location",
      },
    ]),
    { terminal: true, taskId: "task" },
  );
  reportSf311Failure(
    "private@example.test",
    "https://example.test?token=private",
    { terminal: true, siteId: "private@example.test" },
  );
  expect(events()[0]).toMatchObject({
    Operation: "create",
    Sf311ActionFailed: 1,
    Sf311ReconciliationBlocked: 0,
  });
  expect(events()[1]).toMatchObject({
    Operation: "job",
    reason: "unspecified",
  });
  expect(JSON.stringify(events())).not.toContain("private");
});

it("finds uncertain delivery in nested pending attachments without counting tickets twice", () => {
  reportSf311Results(
    /** @type {any} */ ([
      {
        code: "create_311_ticket",
        status: "failed",
        reason: "attachment_submission_failed",
        payload: {
          tickets: [
            {
              srNum: "synthetic",
              attachments: [
                { status: "submitted" },
                {
                  status: "pending",
                  reason: "sf311_attachment_uncertain_requires_reconciliation",
                },
                {
                  status: "pending",
                  reason: "sf311_attachment_uncertain_requires_reconciliation",
                },
              ],
            },
          ],
        },
      },
    ]),
    { terminal: true },
  );
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({
    Operation: "create",
    reason: "sf311_attachment_uncertain_requires_reconciliation",
    Sf311ReconciliationBlocked: 1,
    Sf311ActionFailed: 0,
  });
});

it.each([null, "legacy", [null, 42, {}]])(
  "does not break an action on malformed legacy details: %j",
  (closures) => {
    expect(() =>
      reportSf311Results(
        /** @type {any} */ ([
          {
            code: "close_311_ticket",
            status: "failed",
            payload: { closures },
          },
        ]),
        { terminal: true },
      ),
    ).not.toThrow();
    expect(events()[0].Sf311ActionFailed).toBe(1);
  },
);

it("does not alter operation results or errors when logging fails", async () => {
  log.mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  await expect(
    observeSf311Request("create", async () => "accepted"),
  ).resolves.toBe("accepted");
  const error = new Sf311Error("rejected", { code: "21" });
  await expect(
    observeSf311Request("create", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it("normalizes fetch network failures through the real client", async () => {
  const client = createSf311Client({
    config: /** @type {any} */ ({
      sf311BasicAuthUser: "synthetic",
      sf311BasicAuthPass: "synthetic",
      sf311LatestUpdatesUrl: "https://hub.example.test/latest/{agencyID}",
    }),
    fetchImpl: vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  });
  await expect(client.getLatestUpdatesBySourceAgency()).rejects.toMatchObject({
    code: "sf311_network_error",
  });
  expect(events()[0]).toMatchObject({
    Operation: "status",
    category: "network",
    Sf311ConnectionFailed: 1,
  });
});

it("instruments status, creation and update operations through the real client", async () => {
  const client = createSf311Client({
    config: /** @type {any} */ ({
      sf311BasicAuthUser: "synthetic",
      sf311BasicAuthPass: "synthetic",
      sf311CreateSrUrl: "https://hub.example.test/create",
      sf311UpdateSrUrl: "https://hub.example.test/update",
      sf311LatestUpdatesUrl: "https://hub.example.test/latest/{agencyID}",
    }),
    fetchImpl: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              SRNum: "synthetic",
              UpdateID: "synthetic",
              return_code: "0",
            },
          }),
        ),
    ),
  });
  await client.getLatestUpdatesBySourceAgency();
  await client.createServiceRequest({});
  for (const type of ["11", "8", "5"])
    await client.updateServiceRequest({ UpdateType: type });
  expect(events().map((event) => event.Operation)).toEqual([
    "status",
    "create",
    "close",
    "attachment",
    "note",
  ]);
});
