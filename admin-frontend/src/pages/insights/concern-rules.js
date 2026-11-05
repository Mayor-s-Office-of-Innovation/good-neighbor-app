// Matches the server's CONCERN_RULES (backend/src/reporting/api/read-model.js);
// a backend test holds the two together. No imports, so that test can load it.
export const CONCERN_RULES = Object.freeze({
  checksPerDay: 3,
  severeIssues: 2,
  issuesPer30Days: 4,
  unresolvedDays: 14,
});
