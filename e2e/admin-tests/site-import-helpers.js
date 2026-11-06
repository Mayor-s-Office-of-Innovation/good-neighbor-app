// Shared by site-import-flow.spec.js and app-site-import.test.js, so both read the same rows.

/** One row per status and reason the review table explains. */
export const importRows = [
  { rowNumber: 2, classification: "create", source: { "Site name": "A" } },
  { rowNumber: 3, classification: "reuse", source: { Provider: "P" } },
  {
    rowNumber: 4,
    classification: "acceptable",
    reasonCode: "missing_optional_value",
    existingValue: "Site manager phone",
    source: { Program: "G" },
  },
  {
    rowNumber: 5,
    classification: "acceptable",
    reasonCode: "missing_optional_value",
  },
  {
    rowNumber: 6,
    classification: "invalid",
    reasonCode: "missing_required_value",
    existingValue: "Site address",
  },
  {
    rowNumber: 7,
    classification: "invalid",
    reasonCode: "missing_required_value",
  },
  { rowNumber: 8, classification: "conflict", reasonCode: "site_conflict" },
  { rowNumber: 9, classification: "conflict" },
  { rowNumber: 10, outcome: "applied" },
  {
    rowNumber: 11,
    outcome: "retryable_failed",
    reasonCode: "retryable_apply_error",
  },
  { rowNumber: 12, outcome: "failed", reasonCode: "retryable_apply_error" },
  {
    rowNumber: 13,
    outcome: "skipped_conflict",
    reasonCode: "changed_after_preview",
  },
  { rowNumber: 14, outcome: "failed", reasonCode: "unexpected_apply_error" },
];

export const importPreview = {
  importId: "i1",
  previewVersion: 1,
  previewExpiresAt: "2026-10-30T12:00:00Z",
  counts: { create: 1, reuse: 1, acceptable: 2, invalid: 2, conflict: 2 },
  rows: importRows,
};
