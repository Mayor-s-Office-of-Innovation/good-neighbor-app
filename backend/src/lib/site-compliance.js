// Canonical effective-dated requirements. Site #META snapshots are write-side
// conveniences, never evidence that a compliance period exists.
import { getDynamoTableName } from "../config.js";
import { queryAllItems } from "./query-all-items.js";
import { addDays, pacificToday } from "./pacific-dates.js";

/** @param {string} siteId @param {string} [tableName] */
export async function readCompliancePeriods(
  siteId,
  tableName = getDynamoTableName(),
) {
  return (
    await queryAllItems({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": "COMPLIANCE_TERMS#",
      },
      ConsistentRead: true,
      ScanIndexForward: false,
    })
  ).Items;
}

/** @param {Record<string, any>} term */
export function periodEndExclusive(term) {
  const boundaries = [
    term.expiresOnExclusive,
    term.periodEnd ? addDays(term.periodEnd, 1) : "",
  ].filter(Boolean);
  return boundaries.sort()[0] || "";
}

/** @param {Record<string, any>[]} periods @param {string} [today] */
export function activeCompliancePeriod(periods, today = pacificToday()) {
  return [...periods]
    .filter(
      (term) =>
        term.status !== "cancelled" &&
        !term.endedAt &&
        term.effectiveStart &&
        term.effectiveStart <= today &&
        (!periodEndExclusive(term) || today < periodEndExclusive(term)),
    )
    .sort(
      (a, b) =>
        String(b.effectiveStart).localeCompare(String(a.effectiveStart)) ||
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )[0];
}

/** Only canonical period IDs can make an artifact a current or past compliance letter.
 * @param {Record<string, any>} site @param {Record<string, any>[]} periods @param {string} [today]
 */
export function projectSiteCompliance(site, periods, today = pacificToday()) {
  const valid = periods.filter(
    (term) => term.status !== "cancelled" && term.effectiveStart,
  );
  const active = activeCompliancePeriod(valid, today);
  const byId = new Map(valid.map((term) => [term.termsVersionId, term]));
  const compliance = active
    ? {
        perimeterChecksRequired: true,
        underEnhancedMonitoring:
          active.underEnhancedMonitoring === true ||
          (active.reasons || []).includes("6"),
        periodStart: active.effectiveStart,
        ...(periodEndExclusive(active)
          ? { periodEnd: addDays(periodEndExclusive(active), -1) }
          : {}),
        requiredChecksPerDay: active.requiredChecksPerDay,
      }
    : { perimeterChecksRequired: false, underEnhancedMonitoring: false };
  const seen = new Set();
  const letters = [
    site.complianceLetters?.current,
    ...(site.complianceLetters?.past || []),
  ]
    .filter(Boolean)
    .flatMap((letter) => {
      const term = letter.termsVersionId && byId.get(letter.termsVersionId);
      if (
        !term ||
        term.effectiveStart > today ||
        seen.has(letter.termsVersionId)
      )
        return [];
      seen.add(letter.termsVersionId);
      return [
        {
          ...letter,
          effectiveStart: term.effectiveStart,
          ...(periodEndExclusive(term)
            ? {
                effectiveEnd:
                  term.endedOn || addDays(periodEndExclusive(term), -1),
              }
            : {}),
        },
      ];
    });
  const current = active
    ? letters.find(
        (letter) => letter.termsVersionId === active.termsVersionId,
      ) || null
    : null;
  return {
    compliance,
    compliancePeriods: valid
      .map((term) => ({
        termsVersionId: term.termsVersionId,
        effectiveStart: term.effectiveStart,
        ...(periodEndExclusive(term)
          ? {
              effectiveEnd:
                term.endedOn || addDays(periodEndExclusive(term), -1),
            }
          : {}),
        requiredChecksPerDay: term.requiredChecksPerDay,
        status:
          term === active
            ? "active"
            : term.effectiveStart > today
              ? "scheduled"
              : "past",
      }))
      .sort((a, b) => b.effectiveStart.localeCompare(a.effectiveStart)),
    complianceLetters: {
      current,
      past: letters
        .filter((letter) => letter !== current)
        .sort((a, b) => b.effectiveStart.localeCompare(a.effectiveStart)),
    },
    // Do not describe an ended/superseded job as a current letter still being generated.
    letterState: active
      ? current
        ? "generated"
        : site.latestComplianceTermsVersionId === active.termsVersionId &&
            site.letterState === "draft_pending"
          ? "draft_pending"
          : "none"
      : "archived",
  };
}
