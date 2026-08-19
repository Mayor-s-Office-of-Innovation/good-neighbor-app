import { describe, expect, it } from "vitest";
import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";
import {
  buildCatalog,
  parsePredicate,
  parseSeverityRange,
  questionKeyForPrompt,
  validateCatalog,
} from "./rule-catalog.js";
import { resolveCategory } from "./category-resolver.js";

describe("actions/escalations v2 catalog", () => {
  it("normalizes and validates the v2 rulebase", () => {
    expect(actionsEscalationsV2Catalog.policyVersion).toBe(
      "actions-escalations-v2",
    );
    expect(actionsEscalationsV2Catalog.metadata).toMatchObject({
      sourceAsset: "actions-escalations-rules-v2.csv",
      effectiveDate: "2026-08-18",
      changelogPath: "docs/guidance-policy-changelog.md",
    });
    expect(actionsEscalationsV2Catalog.rules).toHaveLength(26);
    expect(validateCatalog(actionsEscalationsV2Catalog)).toEqual([]);
  });

  it("normalizes severity ranges and stable question keys", () => {
    expect(parseSeverityRange("1-5")).toEqual({ min: 1, max: 5 });
    expect(parseSeverityRange("1")).toEqual({ min: 1, max: 1 });
    expect(questionKeyForPrompt("Is this on site property?")).toBe("onsite");
    expect(questionKeyForPrompt("Are these items from your site?")).toBe(
      "provider_generated",
    );
    expect(questionKeyForPrompt("Are they a site client or resident?")).toBe(
      "affiliated",
    );
  });

  it("normalizes location predicates to the boolean onsite answer key", () => {
    expect(parsePredicate("location == provider_controlled_property")).toEqual({
      all: [{ fact: "onsite", op: "eq", value: true }],
    });
    expect(parsePredicate("location != provider_controlled_property")).toEqual({
      all: [{ fact: "onsite", op: "eq", value: false }],
    });
  });

  it("normalizes app actions into executable action codes", () => {
    const graffiti = actionsEscalationsV2Catalog.rules.find(
      (rule) => rule.ruleId === "GRAFFITI-2",
    );
    expect(graffiti?.outcome.appActions).toEqual([
      { code: "create_311_ticket", payload: { category311: "Graffiti" } },
      { code: "compose_email", payload: { to: "zerograffiti@sfdpw.org" } },
    ]);

    const animal = actionsEscalationsV2Catalog.rules.find(
      (rule) => rule.ruleId === "ANIMAL-2",
    );
    expect(animal?.outcome.appActions).toEqual([
      { code: "open_phone", payload: { phoneNumber: "(415) 554-9400" } },
      {
        code: "create_311_ticket",
        payload: { category311: "Animal care and control" },
      },
    ]);
  });

  it("resolves analyzer category aliases to canonical rule categories", () => {
    expect(
      resolveCategory("Temporary shelters", actionsEscalationsV2Catalog),
    ).toEqual({
      kind: "resolved",
      category: "Tents, tarps, or bedding",
      resolution: "alias",
    });
    expect(resolveCategory("Litter", actionsEscalationsV2Catalog)).toEqual({
      kind: "resolved",
      category: "Litter",
      resolution: "exact",
    });
    expect(
      resolveCategory("Mystery condition", actionsEscalationsV2Catalog),
    ).toEqual({
      kind: "unresolved",
      analyzerCategory: "Mystery condition",
    });
  });

  it("reports catalog validation errors for duplicate rules and bad aliases", () => {
    const catalog = buildCatalog({
      policyVersion: "test",
      aliases: [{ analyzerCategory: "Ghost", canonicalCategory: "Missing" }],
      rows: [
        [
          "Litter",
          "Low",
          "DUP-1",
          "1",
          "1-2",
          "",
          "",
          "Action",
          "Pick up.",
          "",
          "",
          "",
          "Guidance.",
          "",
          "Source",
        ],
        [
          "Litter",
          "Low",
          "DUP-1",
          "1",
          "3-5",
          "",
          "",
          "Action",
          "Pick up.",
          "",
          "",
          "",
          "Guidance.",
          "",
          "Source",
        ],
      ],
    });

    expect(validateCatalog(catalog)).toEqual([
      "Duplicate ruleId DUP-1",
      "Alias Ghost points to unknown Missing",
    ]);
  });
});
