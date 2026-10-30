import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { run, report } = vi.hoisted(() => ({ run: vi.fn(), report: vi.fn() }));
vi.mock("../workers/sf311-job.js", () => ({
  handler: run,
  MAX_FILING_ATTEMPTS: 5,
}));
vi.mock("../integrations/sf311-observability.js", async (importOriginal) => ({
  ...(await importOriginal()),
  reportSf311Failure: report,
}));
const { handler } = await import("./sf311-worker.js");
beforeEach(() => {
  run.mockReset().mockResolvedValue(undefined);
  report.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("isolates failed records while acknowledging successful jobs", async () => {
  const error = Object.assign(new Error("Private upstream error"), {
    name: "AccessDeniedException",
    $metadata: { requestId: "synthetic-request", httpStatusCode: 403 },
  });
  const frame = "    at readJob (file:///var/task/index.mjs:42:7)";
  error.stack = `${error.name}: ${error.message}\n${frame}`;
  run.mockRejectedValueOnce(error);
  const result = await handler(
    /** @type {any} */ ({
      Records: [
        { messageId: "failed", body: '{"type":"sf311_job"}' },
        { messageId: "ok", body: '{"type":"sf311_job"}' },
      ],
    }),
  );
  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "failed" }] });
  expect(run).toHaveBeenCalledTimes(2);
  expect(report).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledOnce();
  const entry = JSON.parse(vi.mocked(console.error).mock.calls[0][0]);
  expect(entry).toMatchObject({
    name: "AccessDeniedException",
    messageId: "failed",
    awsRequestId: "synthetic-request",
    httpStatus: 403,
  });
  expect(entry.stack).toContain(frame);
  expect(JSON.stringify(entry)).not.toContain("Private upstream error");
});

it.each(["not-json", '{"type":"translate_artifact"}'])(
  "rejects invalid jobs without invoking another worker: %s",
  async (body) => {
    expect(
      await handler(
        /** @type {any} */ ({
          Records: [
            {
              messageId: "bad",
              body,
              attributes: { ApproximateReceiveCount: "5" },
            },
          ],
        }),
      ),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
    expect(run).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("job", "invalid_job", {
      terminal: true,
      messageId: "bad",
    });
  },
);
