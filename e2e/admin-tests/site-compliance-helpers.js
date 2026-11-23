// The default Site is ready for a letter and has no active check requirement,
// so each spec adds only the gap it tests.
import { adminData } from "./admin-mock.js";

/**
 * Loosely typed so specs can add the optional fields the API returns.
 * @param {{ active?: boolean }} [options]
 * @returns {any}
 */
export function complianceData({ active = false } = {}) {
  const data = /** @type {any} */ (adminData());
  const site = data.sites[0];
  site.oversight = {
    ...site.oversight,
    managingCityDepartment: "Example Department",
    managingSystemOfCare: "Example System",
  };
  data.terms = active
    ? [
        {
          effectiveStart: "2026-01-01",
          reasons: ["3"],
          requiredChecksPerDay: 3,
          createdAt: "2026-01-01T10:00:00Z",
          // Far-future limits keep this period active on any test date.
          periodEnd: "2098-12-31",
          expiresOnExclusive: "2099-01-01",
        },
        {
          effectiveStart: "2025-07-01",
          periodEnd: "2025-09-30",
          endedAt: "2025-09-30T10:00:00Z",
          reasons: ["1"],
          requiredChecksPerDay: 1,
          createdAt: "2025-07-01T10:00:00Z",
        },
        {
          effectiveStart: "2024-01-01",
          status: "cancelled",
          reasons: ["2"],
          requiredChecksPerDay: 1,
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          effectiveStart: "2025-01-01",
          endedOn: "2025-06-01",
          endedAt: "2025-06-01T10:00:00Z",
          reasons: [],
          underEnhancedMonitoring: true,
          requiredChecksPerDay: 2,
          createdAt: "2025-01-01T10:00:00Z",
        },
      ]
    : [];
  data.terms.forEach((/** @type {any} */ term) => (term.siteId = "s1"));
  return data;
}

export const compliancePath = "/sites/s1?section=compliance";
export const oversightPath = "/sites/s1?section=oversight";

/** A sent letter email as the status and letters reads return it.
 * @param {string} jobId
 * @param {Record<string, any>} [extra]
 */
export function letterEmail(jobId, extra = {}) {
  return {
    sk: `LETTER_EMAIL#${jobId}`,
    type: "complianceLetterEmail",
    letterJobId: jobId,
    number: 1,
    sentAt: "2026-10-02T10:00:00Z",
    recipients: ["site@example.org"],
    provider: "ses",
    letter: { url: "https://example.org/letter.pdf", fileName: "letter.pdf" },
    ...extra,
  };
}
