import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock both underlying workers so we assert only which one the dispatcher routes
// a message to, by its shape — not what the worker itself does.
const { processSubmission, analyzeArtifact } = vi.hoisted(() => ({
  processSubmission: vi.fn(async () => {}),
  analyzeArtifact: vi.fn(async () => {}),
}));
vi.mock("../workers/process-submission.js", () => ({
  handler: processSubmission,
}));
vi.mock("../workers/analyze-artifact.js", () => ({ handler: analyzeArtifact }));

const { handler } = await import("./worker.js");

/**
 * @param {unknown} body
 * @returns {any} an SQS-style event wrapping the JSON-encoded body
 */
function event(body) {
  return /** @type {any} */ ({
    Records: [{ messageId: "m1", body: JSON.stringify(body) }],
  });
}

describe("worker dispatch (pickHandler)", () => {
  beforeEach(() => {
    processSubmission.mockClear();
    analyzeArtifact.mockClear();
  });

  it("routes a photo artifact (s3Key) to the analyze worker", async () => {
    await handler(
      event({ checkId: "c1", artifactId: "a1", s3Key: "k" }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(analyzeArtifact).toHaveBeenCalledTimes(1);
    expect(processSubmission).not.toHaveBeenCalled();
  });

  it("routes a text artifact (text, no s3Key) to the analyze worker", async () => {
    // Regression: text descriptions have no s3Key, so the old s3Key-only
    // predicate misrouted them to the submission handler, which then blew up on
    // JSON.parse(undefined).
    await handler(
      event({ checkId: "c1", artifactId: "a1", text: "trash" }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(analyzeArtifact).toHaveBeenCalledTimes(1);
    expect(processSubmission).not.toHaveBeenCalled();
  });

  it("routes a /submissions message (requestId + body) to the submission worker", async () => {
    await handler(
      event({ requestId: "r1", subject: "s", body: "{}" }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(processSubmission).toHaveBeenCalledTimes(1);
    expect(analyzeArtifact).not.toHaveBeenCalled();
  });
});
