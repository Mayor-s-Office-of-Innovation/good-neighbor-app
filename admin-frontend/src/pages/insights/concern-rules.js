// Matches the server's CONCERN_RULES (backend/src/reporting/api/read-model.js);
// a backend test holds the two together. No imports, so that test can load it.
export const CONCERN_RULES = Object.freeze({
  // The app's DEFAULT_REQUIRED_CHECKS_PER_DAY, for help text that can't name a Site's own number.
  defaultChecksPerDay: 3,
  severeIssues: 2,
  issuesPer30Days: 4,
  unresolvedDays: 14,
});
