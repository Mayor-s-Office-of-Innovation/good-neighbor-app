// Hand-authored, schema-valid `good-neighbor-app` v1.0.0 response: a single
// Low-weighted concern (litter), grade "Fair".

/** @type {import("../contract.js").AnalysisResponse} */
export const singleLowConcernResponse = {
  analysis_id: "ana_20260814_litter1",
  rubric: { id: "good-neighbor-app", version: "1.0.0" },
  created_at: "2026-08-14T15:05:00.000Z",
  model: { provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0" },
  caller: { app_id: "good-neighbor-app", request_id: "chk_01#art_02" },
  assessment: {
    metadata: { position_descriptor: "East side, along the curb" },
    general_conditions: {
      label: "Fair",
      description:
        "The perimeter shows some concerns that may affect comfort or cleanliness — several wrappers along the curb — but are not an urgent hazard.",
    },
    identified_conditions_of_concern: [
      {
        category: "Litter",
        definition: "Scattered small refuse or litter that does not obstruct movement.",
        severity: 2,
        severity_label: "Minor: Increasing quantity, size, or spatial impact",
        description: "Several wrappers and a plastic bag scattered along the curb.",
        evidence_indices: [0],
        confidence: 0.82,
      },
    ],
  },
};
