/**
 * Representative cases used by policy diff reports. Keep this set small and
 * behavior-focused; evaluator unit tests carry exhaustive branch coverage.
 * @type {import("../rulebase-diff.js").GuidanceFixture[]}
 */
export const rulebaseImpactFixtures = [
  {
    id: "litter-small-action",
    condition: { category: "Litter", severity: 1 },
  },
  {
    id: "litter-large-311",
    condition: { category: "Litter", severity: 4 },
  },
  {
    id: "bulky-provider-action",
    condition: { category: "Bulky items", severity: 3 },
    answers: { provider_generated: true },
  },
  {
    id: "bulky-public-311",
    condition: { category: "Bulky items", severity: 3 },
    answers: { provider_generated: false },
  },
  {
    id: "graffiti-needs-onsite-answer",
    condition: { category: "Graffiti", severity: 2 },
  },
  {
    id: "graffiti-onsite-action",
    condition: { category: "Graffiti", severity: 2 },
    answers: { onsite: true },
  },
  {
    id: "graffiti-offsite-escalation",
    condition: { category: "Graffiti", severity: 2 },
    answers: { onsite: false },
  },
  {
    id: "fire-low-311",
    condition: { category: "Fire hazard", severity: 3 },
  },
  {
    id: "fire-high-911",
    condition: { category: "Fire hazard", severity: 5 },
  },
  {
    id: "alias-large-waste",
    condition: { category: "Large waste", severity: 2 },
    answers: { provider_generated: false },
  },
  {
    id: "severity-zero",
    condition: { category: "Litter", severity: 0 },
  },
  {
    id: "unmapped-category",
    condition: { category: "Mystery condition", severity: 3 },
  },
];
