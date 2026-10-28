const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { describe, expect, it, vi } from "vitest";
import {
  projectSiteCompliance,
  activeCompliancePeriod,
  readCompliancePeriods,
} from "./site-compliance.js";
import {
  requirementFromCompliance,
  requiredOnResolver,
} from "../domain/check-compliance.js";
const today = "2026-10-28";
const term = {
  termsVersionId: "v1",
  effectiveStart: "2026-10-01",
  requiredChecksPerDay: 4,
  reasons: ["6"],
  status: "active",
};
const letter = {
  termsVersionId: "v1",
  s3Key: "synthetic/v1.pdf",
  effectiveStart: term.effectiveStart,
};

describe("canonical compliance periods and letters", () => {
  it("does not invent a requirement or current letter from a legacy snapshot", () => {
    const projection = projectSiteCompliance(
      {
        compliance: { requiredChecksPerDay: 4 },
        complianceLetters: {
          current: { url: "/sample-compliance-letter.pdf" },
          past: [letter],
        },
      },
      [],
      today,
    );
    expect(projection.compliance.perimeterChecksRequired).toBe(false);
    expect(projection.complianceLetters).toEqual({ current: null, past: [] });
  });
  it("projects cadence, monitoring, and current letter from the active version", () => {
    const projection = projectSiteCompliance(
      { complianceLetters: { current: letter } },
      [term],
      today,
    );
    expect(projection.compliance).toMatchObject({
      perimeterChecksRequired: true,
      periodStart: term.effectiveStart,
      requiredChecksPerDay: 4,
      underEnhancedMonitoring: true,
    });
    expect(projection.complianceLetters.current?.termsVersionId).toBe("v1");
  });
  it("archives a current pointer immediately on natural expiry, before the sweep runs", () => {
    const projection = projectSiteCompliance(
      { complianceLetters: { current: letter } },
      [{ ...term, periodEnd: "2026-10-27", expiresOnExclusive: today }],
      today,
    );
    expect(projection.compliance.perimeterChecksRequired).toBe(false);
    expect(projection.complianceLetters.current).toBeNull();
    expect(projection.complianceLetters.past).toHaveLength(1);
    expect(projection.letterState).toBe("archived");
  });
  it("does not show the previous letter as current while the replacement generates", () => {
    const projection = projectSiteCompliance(
      {
        latestComplianceTermsVersionId: "v2",
        letterState: "draft_pending",
        complianceLetters: { current: letter },
      },
      [
        { ...term, expiresOnExclusive: today },
        { ...term, termsVersionId: "v2", effectiveStart: today },
      ],
      today,
    );
    expect(projection.complianceLetters.current).toBeNull();
    expect(projection.complianceLetters.past[0].termsVersionId).toBe("v1");
    expect(projection.letterState).toBe("draft_pending");
  });
  it("deduplicates artifacts and excludes cancelled, future, and unmatched versions", () => {
    const projection = projectSiteCompliance(
      {
        complianceLetters: {
          current: letter,
          past: [
            letter,
            { ...letter, termsVersionId: "cancelled" },
            { ...letter, termsVersionId: "future" },
            { url: "/sample-compliance-letter.pdf" },
          ],
        },
      },
      [
        term,
        { ...term, termsVersionId: "cancelled", status: "cancelled" },
        { ...term, termsVersionId: "future", effectiveStart: "2026-11-01" },
      ],
      today,
    );
    expect(projection.complianceLetters.current?.termsVersionId).toBe("v1");
    expect(projection.complianceLetters.past).toEqual([]);
    expect(
      activeCompliancePeriod(
        [{ ...term, endedAt: "2026-10-28T00:00:00Z" }],
        today,
      ),
    ).toBeUndefined();
  });
  it("keeps historical obligations after the current requirement is ended", () => {
    const ended = {
      ...term,
      expiresOnExclusive: today,
      endedAt: "2026-10-28T00:00:00Z",
      endedOn: today,
    };
    const projection = projectSiteCompliance({}, [ended], today);
    const required = requiredOnResolver(
      requirementFromCompliance(projection.compliance),
      [ended],
    );
    expect(required("2026-10-27")).toBe(4);
    expect(required(today)).toBe(0);
    expect(projection.compliancePeriods[0].effectiveEnd).toBe(today);
  });
});

it("reads every canonical period page consistently", async () => {
  send
    .mockReset()
    .mockResolvedValueOnce({
      Items: [term],
      LastEvaluatedKey: { pk: "SITE#site", sk: "COMPLIANCE_TERMS#cursor" },
    })
    .mockResolvedValueOnce({ Items: [{ ...term, termsVersionId: "v2" }] });
  expect(await readCompliancePeriods("site", "synthetic-table")).toHaveLength(
    2,
  );
  expect(send.mock.calls[1][0].input).toMatchObject({
    ConsistentRead: true,
    ExclusiveStartKey: { pk: "SITE#site", sk: "COMPLIANCE_TERMS#cursor" },
  });
});
