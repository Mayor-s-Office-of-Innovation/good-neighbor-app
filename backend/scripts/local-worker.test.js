import { describe, expect, it, vi } from "vitest";

const { runJobs } = vi.hoisted(() => ({
  runJobs: vi.fn(async () => ({ batchItemFailures: [] })),
}));
vi.mock("../src/lambda/analytics-query.js", () => ({ runJobs }));

const { pickHandler, settleBatch } = await import("./local-worker.mjs");
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

describe("settleBatch", () => {
  it("moves on while an Insights job runs, so photo analysis isn't held up", async () => {
    const insights = JSON.stringify({
      insightsJob: { ownerKey: "o", jobId: "j" },
    });
    let analysed = false;
    const settled = await Promise.race([
      settleBatch(
        [
          { Body: insights },
          { Body: JSON.stringify({ artifactId: "a", s3Key: "k" }) },
        ],
        [
          new Promise(() => {}),
          Promise.resolve().then(() => {
            analysed = true;
          }),
        ],
      ).then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 50)),
    ]);
    expect(settled).toBe("settled");
    expect(analysed).toBe(true);
  });
});

describe("entry check", () => {
  it("imports without argv[1], as `node -e` leaves it", async () => {
    const argv = process.argv;
    process.argv = [argv[0]];
    try {
      vi.resetModules();
      await expect(import("./local-worker.mjs")).resolves.toHaveProperty(
        "pickHandler",
      );
    } finally {
      process.argv = argv;
    }
  });
});
