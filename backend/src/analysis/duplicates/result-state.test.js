import { expect, it } from "vitest";
import {
  visibleDuplicateState,
  processingState,
  normalizeConditionOutcome,
} from "./result-state.js";
it("bounds pending presentation without turning failures into negative matches", () => {
  const now = Date.now();
  expect(
    visibleDuplicateState("pending", new Date(now - 899999).toISOString(), now),
  ).toBe("pending");
  expect(
    visibleDuplicateState("pending", new Date(now - 900000).toISOString(), now),
  ).toBe("unavailable");
  expect(visibleDuplicateState("pending", undefined, now)).toBe("unavailable");
  expect(visibleDuplicateState("matched", undefined, now)).toBe("matched");
  expect(visibleDuplicateState("complete", undefined, now)).toBe("complete");
});

it("classifies legacy and new failed negatives as incomplete while preserving positives", () => {
  for (const assessmentOutcome of ["no_match_with_failures", "incomplete"]) {
    const row = {
      conditionId: "issue",
      status: "evaluated",
      possibleDuplicate: false,
      duplicateOf: null,
      matchStrength: null,
      assessmentOutcome,
      failedCandidateCount: 3,
    };
    expect(
      processingState({ status: "evaluated", conditionResults: [row] }),
    ).toBe("incomplete");
    expect(normalizeConditionOutcome(row)).toMatchObject({
      possibleDuplicate: null,
      status: "insufficient_evidence",
      assessmentOutcome: "incomplete",
    });
    const positive = {
      ...row,
      possibleDuplicate: true,
      assessmentOutcome: "matched",
    };
    expect(normalizeConditionOutcome(positive)).toBe(positive);
    expect(
      processingState({ status: "evaluated", conditionResults: [positive] }),
    ).toBe("complete");
  }
  expect(processingState({ status: "pending" })).toBe("pending");
  expect(processingState({ status: "failed" })).toBe("retrying");
});
