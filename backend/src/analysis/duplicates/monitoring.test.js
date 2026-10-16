import { expect, it, vi } from "vitest";
import { duplicateEvent } from "./monitoring.js";
it("emits content-free CloudWatch metrics using an explicit allowlist", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.METRICS_NAMESPACE = "test-duplicates";
  duplicateEvent(
    "comparison",
    {
      siteId: "site",
      observationId: "check:photo",
      outcome: "matched",
      confidence: "high",
      description: "sensitive narrative",
      base64: "private image",
      reason: "private model explanation",
      modelId: "amazon.nova-lite-v1:0",
    },
    [{ name: "DuplicateComparisons", value: 1 }],
  );
  const event = JSON.parse(log.mock.calls[0][0]);
  expect(event).toMatchObject({
    outcome: "matched",
    confidence: "high",
    observationId: "check:photo",
  });
  expect(event._aws.CloudWatchMetrics[0]).toMatchObject({
    Namespace: "test-duplicates",
    Dimensions: [[]],
  });
  expect(JSON.stringify(event)).not.toContain("private");
  expect(event.description).toBeUndefined();
  log.mockRestore();
  delete process.env.METRICS_NAMESPACE;
});

it("keeps incomplete no-match diagnostics without narrative evidence", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    duplicateEvent(
      "issue_result",
      {
        outcome: "no_match_with_failures",
        failedCandidates: 1,
        reason: "private",
      },
      [{ name: "DuplicateIncompleteNoMatchIssues", value: 1 }],
    );
    const event = JSON.parse(log.mock.calls[0][0]);
    expect(event).toMatchObject({
      outcome: "no_match_with_failures",
      failedCandidates: 1,
    });
    expect(event.reason).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});
