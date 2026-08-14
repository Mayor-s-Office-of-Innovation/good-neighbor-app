// Hand-authored, schema-valid `good-neighbor-app` v1.0.0 response: a clean
// perimeter side with no conditions of concern. The upstream repo's fixtures
// use the old street-conditions labels, so we author our own GNA-flavored ones.

/** @type {import("../contract.js").AnalysisResponse} */
export const excellentResponse = {
  analysis_id: "ana_20260814_clean01",
  rubric: { id: "good-neighbor-app", version: "1.0.0" },
  created_at: "2026-08-14T15:00:00.000Z",
  model: { provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0" },
  caller: { app_id: "good-neighbor-app", request_id: "chk_01#art_01" },
  assessment: {
    metadata: { position_descriptor: "North side, main entrance" },
    general_conditions: {
      label: "Excellent",
      description:
        "No concerning street conditions were observed along the perimeter. Streets appear clean, safe, and unobstructed.",
    },
    identified_conditions_of_concern: [],
  },
};
