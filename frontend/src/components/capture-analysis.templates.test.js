import { describe, expect, it } from "vitest";
import { captureLabels } from "./capture-analysis.templates.js";
import { shotTile } from "./perimeter-check.templates.js";
import { t } from "../i18n/i18n.js";

const photo = (status, conditions = []) => ({
  id: "photo",
  kind: "photo",
  dataUrl: "data:photo",
  analysis: { status, conditions },
});

describe("capture analysis feedback", () => {
  it.each(["queued", "analyzing"])(
    "scans %s photos and shows the placeholder",
    (status) => {
      expect(shotTile(photo(status), 0)).toContain('class="capture-scanner"');
      expect(captureLabels([photo(status)])).toContain(
        "capture-label--pending",
      );
    },
  );

  it.each(["analyzed", "failed", undefined])(
    "removes scanning and the placeholder when status is %s",
    (status) => {
      expect(shotTile(photo(status), 0)).not.toContain(
        'class="capture-scanner"',
      );
      expect(captureLabels([photo(status)])).not.toContain(
        "capture-label--pending",
      );
    },
  );

  it("shows deduplicated, translated categories above the placeholder until all photos settle", () => {
    const items = [
      photo("analyzed", [
        { category: "Waste & Small Debris" },
        { category: "Litter" },
      ]),
      photo("analyzing", [{ category: "Graffiti" }]),
    ];
    const markup = captureLabels(items);
    expect(markup.match(/data-category="litter-b192"/g)).toHaveLength(1);
    expect(markup).toContain(t("rulebook.category.litter-b192"));
    expect(markup.indexOf('data-category="graffiti-d371"')).toBeLessThan(
      markup.indexOf("capture-label--pending"),
    );
    items[1].analysis.status = "failed";
    expect(captureLabels(items)).not.toContain("capture-label--pending");
    expect(captureLabels(items)).toContain('data-category="litter-b192"');
  });

  it("uses task categories and omits resolved/rejected conditions", () => {
    const item = photo("analyzed", [
      { category: "Litter", conditionId: "hidden" },
    ]);
    item.analysis.rejectedConditionIds = ["hidden"];
    item.analysis.tasks = [
      { category: "Temporary shelters", conditionId: "visible" },
    ];
    const markup = captureLabels([item]);
    expect(markup).not.toContain('data-category="litter-b192"');
    expect(markup).toContain('data-category="tents-tarps-or-bedding-6368"');
    expect(markup).toContain("encampment-light.png");
    expect(markup).toContain("encampment-dark.png");
  });

  it("covers all fourteen rubric categories", () => {
    const keys = [
      "litter-b192",
      "bulky-items-c8c9",
      "feces-and-urine-1f09",
      "needles-d5d8",
      "tents-tarps-or-bedding-6368",
      "graffiti-d371",
      "fire-hazard-0363",
      "blocked-doorway-or-sidewalk-6db3",
      "public-drug-use-9638",
      "someone-in-distress-0d4e",
      "animals-1780",
      "medical-emergency-1a14",
      "threats-intimidation-or-violence-9166",
      "illegal-parking-878a",
    ];
    const markup = captureLabels([
      photo(
        "analyzed",
        keys.map((key) => ({ category: t(`rulebook.category.${key}`) })),
      ),
    ]);
    for (const key of keys) expect(markup).toContain(`data-category="${key}"`);
    expect(markup).toContain("distress-light.png");
    expect(markup).toContain("distress-dark.png");
  });

  it.each([
    ["Behavioral health", "someone-in-distress-0d4e", "distress"],
    [
      "Intimidation and violence",
      "threats-intimidation-or-violence-9166",
      "threats",
    ],
  ])(
    "preserves capture labels for older analyzer category %s",
    (category, key, icon) => {
      const markup = captureLabels([photo("analyzed", [{ category }])]);
      expect(markup).toContain(`data-category="${key}"`);
      expect(markup).toContain(t(`rulebook.category.${key}`));
      expect(markup).toContain(`${icon}-light.png`);
      expect(markup).toContain(`${icon}-dark.png`);
    },
  );
});
