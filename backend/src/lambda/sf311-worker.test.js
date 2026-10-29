import { beforeEach, expect, it, vi } from "vitest";
const { run, report } = vi.hoisted(() => ({ run: vi.fn(), report: vi.fn() }));
vi.mock("../workers/sf311-job.js", () => ({
  handler: run,
  MAX_FILING_ATTEMPTS: 5,
}));
vi.mock("../integrations/sf311-observability.js", () => ({
  reportSf311Failure: report,
}));
const { handler } = await import("./sf311-worker.js");
beforeEach(() => {
  run.mockReset().mockResolvedValue(undefined);
  report.mockReset();
});

it("isolates failed records while acknowledging successful jobs", async () => {
  run.mockRejectedValueOnce(new Error("Private upstream error"));
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
