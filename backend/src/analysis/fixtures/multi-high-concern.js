// Hand-authored, schema-valid `good-neighbor-app` v1.0.0 response: multiple
// concerns including a High-weighted category at maximum severity, grade
// "Very Poor".

/** @type {import("../contract.js").AnalysisResponse} */
export const multiHighConcernResponse = {
  analysis_id: "ana_20260814_multi01",
  rubric: { id: "good-neighbor-app", version: "1.0.0" },
  created_at: "2026-08-14T15:10:00.000Z",
  model: { provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0" },
  caller: { app_id: "good-neighbor-app", request_id: "chk_01#art_03" },
  assessment: {
    metadata: { position_descriptor: "South side, near loading dock" },
    general_conditions: {
      label: "Very Poor",
      description:
        "The perimeter shows urgent concerns posing an immediate risk to health or safety: exposed needles and a person sleeping outdoors. These need attention as soon as possible.",
    },
    identified_conditions_of_concern: [
      {
        category: "Needles",
        definition: "Visible needles or sharp medical objects posing puncture risk.",
        severity: 5,
        severity_label: "Severe: Increasing number or exposure risk",
        description: "Multiple uncapped syringes on the sidewalk near the dock.",
        evidence_indices: [0, 1],
        confidence: 0.91,
      },
      {
        category: "Temporary shelters",
        definition:
          "Visible evidence of people living or sleeping in public spaces without shelter.",
        severity: 3,
        severity_label: "Moderate: Increasing number, density, or permanence",
        description: "A tent set up against the wall with bedding arranged for living.",
        evidence_indices: [2],
      },
      {
        category: "Litter",
        definition: "Scattered small refuse or litter that does not obstruct movement.",
        severity: 2,
        description: "Loose trash dispersed along the gutter.",
        evidence_indices: [3],
      },
    ],
  },
};
