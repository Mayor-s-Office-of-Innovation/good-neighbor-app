import { describe, expect, it, vi } from "vitest";

const { runJobs } = vi.hoisted(() => ({
  runJobs: vi.fn(async () => ({ batchItemFailures: [] })),
}));
vi.mock("../src/lambda/analytics-query.js", () => ({ runJobs }));

const { pickHandler } = await import("./local-worker.mjs");
const { handler: processSubmission } = await import(
  "../src/workers/process-submission.js"
);
const { handler: analyzeArtifact } = await import(
  "../src/workers/analyze-artifact.js"
);
const { handler: sf311Job } = await import("../src/workers/sf311-job.js");

describe("pickHandler", () => {
  it("sends an Insights job to the code the jobs Lambda runs", async () => {
    const event = { Records: [] };
    const handler = pickHandler(
      JSON.stringify({ insightsJob: { ownerKey: "o", jobId: "j" } }),
    );
    await expect(
      handler(/** @type {any} */ (event), /** @type {any} */ ({}), () => {}),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(runJobs).toHaveBeenCalledWith(event);
  });

  it.each([
    ["a typed message", { type: "sf311_job" }, () => sf311Job],
    [
      "an analyze message",
      { artifactId: "a1", s3Key: "k" },
      () => analyzeArtifact,
    ],
    ["anything else", { submissionId: "s1" }, () => processSubmission],
  ])("routes %s by its shape", (_, message, expected) => {
    expect(pickHandler(JSON.stringify(message))).toBe(expected());
  });

  it("treats a body that isn't JSON as a submission", () => {
    expect(pickHandler("{")).toBe(processSubmission);
  });
});
