import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock both underlying workers so we assert only which one the dispatcher routes
// a message to, by its shape — not what the worker itself does.
const {
  processSubmission,
  analyzeArtifact,
  reconcileSiteRevocation,
  dispatchRevocationOutbox,
  generateComplianceLetter,
  translateArtifact,
} = vi.hoisted(() => ({
  processSubmission: vi.fn(async () => {}),
  analyzeArtifact: vi.fn(async () => {}),
  reconcileSiteRevocation: vi.fn(async () => {}),
  dispatchRevocationOutbox: vi.fn(async () => {}),
  generateComplianceLetter: vi.fn(async () => {}),
  translateArtifact: vi.fn(async () => {}),
}));
vi.mock("../workers/process-submission.js", () => ({
  handler: processSubmission,
}));
vi.mock("../workers/analyze-artifact.js", () => ({ handler: analyzeArtifact }));
vi.mock("../workers/reconcile-site-revocation.js", () => ({
  handler: reconcileSiteRevocation,
}));
vi.mock("../workers/dispatch-revocation-outbox.js", () => ({
  handler: dispatchRevocationOutbox,
}));
vi.mock("../workers/generate-compliance-letter.js", () => ({
  handler: generateComplianceLetter,
}));
vi.mock("../workers/translate-artifact.js", () => ({
  handler: translateArtifact,
}));

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
    reconcileSiteRevocation.mockClear();
    dispatchRevocationOutbox.mockClear();
    generateComplianceLetter.mockClear();
    translateArtifact.mockClear();
  });

  it("routes a translate_artifact message to the translate worker", async () => {
    await handler(
      event({
        type: "translate_artifact",
        siteId: "s1",
        checkId: "c1",
        artifactId: "a1",
        items: [{ user_friendly_label: "Trash", description: "Bags" }],
      }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(translateArtifact).toHaveBeenCalledTimes(1);
    expect(analyzeArtifact).not.toHaveBeenCalled();
    expect(processSubmission).not.toHaveBeenCalled();
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

  it("routes emergency Site reconciliation to the revocation worker", async () => {
    await handler(
      event({ type: "reconcile_site_revocation", operationId: "operation-1" }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(reconcileSiteRevocation).toHaveBeenCalledTimes(1);
    expect(processSubmission).not.toHaveBeenCalled();
    expect(analyzeArtifact).not.toHaveBeenCalled();
  });

  it("routes compliance-letter jobs to the letter worker", async () => {
    await handler(
      event({ type: "generate_compliance_letter", siteId: "site-1" }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(generateComplianceLetter).toHaveBeenCalledTimes(1);
    expect(processSubmission).not.toHaveBeenCalled();
  });

  it("routes DynamoDB stream records to the revocation outbox dispatcher", async () => {
    const result = await handler(
      /** @type {any} */ ({
        Records: [
          {
            eventSource: "aws:dynamodb",
            eventName: "INSERT",
            dynamodb: { SequenceNumber: "123" },
          },
        ],
      }),
      /** @type {any} */ ({}),
      () => {},
    );

    expect(dispatchRevocationOutbox).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
