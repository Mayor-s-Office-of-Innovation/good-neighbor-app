export const guidanceFixtures = [
  {
    id: "mixed-immediate-and-question",
    label: "Mixed conditions",
    assessment: {
      assessmentId: "dev-guidance-mixed",
      checkId: "dev-check-mixed",
      reportedAt: "2026-08-18T12:00:00.000Z",
      rubricVersion: "dev-fixture",
      rawAssessment: {
        source: "dev-harness",
        fixture: "mixed-immediate-and-question",
      },
      conditions: [
        {
          category: "Litter",
          severity: 4,
          description: "Several bags of trash and loose debris near the curb.",
          sourceArtifactIds: ["dev-photo-1"],
        },
        {
          category: "Graffiti",
          severity: 2,
          description: "Tagging on the building frontage.",
          sourceArtifactIds: ["dev-photo-2"],
        },
      ],
    },
  },
  {
    id: "emergency-phone",
    label: "Emergency phone action",
    assessment: {
      assessmentId: "dev-guidance-emergency",
      checkId: "dev-check-emergency",
      reportedAt: "2026-08-18T12:05:00.000Z",
      rubricVersion: "dev-fixture",
      rawAssessment: {
        source: "dev-harness",
        fixture: "emergency-phone",
      },
      conditions: [
        {
          category: "Fire hazard",
          severity: 5,
          description: "Smoke visible near combustible material.",
          sourceArtifactIds: ["dev-photo-fire"],
        },
      ],
    },
  },
  {
    id: "analyzer-aliases",
    label: "Analyzer aliases",
    assessment: {
      assessmentId: "dev-guidance-aliases",
      checkId: "dev-check-aliases",
      reportedAt: "2026-08-18T12:10:00.000Z",
      rubricVersion: "dev-fixture",
      rawAssessment: {
        source: "dev-harness",
        fixture: "analyzer-aliases",
      },
      conditions: [
        {
          category: "Large waste",
          severity: 3,
          description: "Mattress left near the entry path.",
          sourceArtifactIds: ["dev-photo-bulky"],
        },
        {
          category: "Temporary shelters",
          severity: 3,
          description: "Tent and bedding set up near the site edge.",
          sourceArtifactIds: ["dev-photo-tent"],
        },
      ],
    },
  },
];
