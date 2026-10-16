import { it, expect } from "vitest";
import { needsDuplicateJob, analysisRevision, projectionKey } from "./jobs.js";
it("only substantive analysis changes dispatch work, not translations or header counters", () => {
  const row = {
    status: "analyzed",
    checkId: "check",
    artifactId: "art",
    analysisId: "analysis",
    concerns: [
      {
        conditionId: "c",
        rating: 2,
        explanation: "pile",
        translations: { es: { description: "one" } },
      },
    ],
  };
  expect(needsDuplicateJob(undefined, row)).toBe(true);
  expect(
    needsDuplicateJob(row, {
      ...row,
      concerns: [
        { ...row.concerns[0], translations: { es: { description: "two" } } },
      ],
    }),
  ).toBe(false);
  expect(
    needsDuplicateJob(row, {
      ...row,
      concerns: [{ ...row.concerns[0], explanation: "amended" }],
    }),
  ).toBe(true);
  expect(
    needsDuplicateJob(undefined, {
      status: "failed",
      checkId: "check",
      artifactId: "art",
    }),
  ).toBe(false);
  expect(analysisRevision(row)).toHaveLength(64);
});
it("canonical UTC capture-time keys sort chronologically", () => {
  expect(projectionKey("site", "2026-10-14T01:00:00-07:00", "a").sk).toBe(
    "DUP_OBSERVATION#2026-10-14T08:00:00.000Z#a",
  );
});
