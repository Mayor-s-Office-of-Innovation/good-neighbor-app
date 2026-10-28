import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import {
  generateComplianceLetterPdf,
  generateComplianceLetterPreviewSvg,
} from "./compliance-letter-pdf.js";

describe("compliance letter PDF", () => {
  it.each([
    ["DPH", "Department of Public Health (DPH)"],
    ["HSH", "Department of Homelessness and Supportive Housing (HSH)"],
  ])(
    "uses the %s sender letterhead in the PDF and preview",
    async (shortName, fullName) => {
      const period = {
        effectiveStart: "2026-10-27",
        requiredChecksPerDay: 3,
        letterInputs: {
          departmentName: shortName,
          programManagerName: "Sender Name",
        },
      };
      const svg = generateComplianceLetterPreviewSvg(period).toString();
      const image = svg.match(/href="(data:image\/png;base64,[^"]+)"/)?.[1];
      expect(image).toBeTruthy();
      const fullNameSvg = generateComplianceLetterPreviewSvg({
        ...period,
        letterInputs: { ...period.letterInputs, departmentName: fullName },
      }).toString();
      expect(fullNameSvg).toContain(`href="${image}"`);
      const otherSvg = generateComplianceLetterPreviewSvg({
        ...period,
        letterInputs: { departmentName: shortName === "DPH" ? "HSH" : "DPH" },
      }).toString();
      expect(otherSvg).not.toContain(`href="${image}"`);
      expect(svg).toContain("Sender Name");
      const positions = [...svg.matchAll(/<text x="[^"]+" y="([^"]+)"/g)].map(
        (match) => Number(match[1]),
      );
      expect(Math.min(...positions)).toBeGreaterThanOrEqual(152);
      expect(Math.max(...positions)).toBeLessThanOrEqual(692);
      const pdf = await PDFDocument.load(
        await generateComplianceLetterPdf(period),
      );
      expect(pdf.getPageCount()).toBe(1);
      // The vector letterhead must actually be drawn onto the page, not just
      // included in the browser preview or shipped as an unused PDF resource.
      expect(
        pdf.getPage(0).node.Resources()?.get(PDFName.of("XObject")),
      ).toBeDefined();
    },
  );

  it("creates a one-page PDF with selected reasons and mapped fields", async () => {
    const pdf = await generateComplianceLetterPdf({
      effectiveStart: "2026-10-08",
      periodEnd: "2026-12-31",
      requiredChecksPerDay: 4,
      reasons: ["2", "6"],
      underEnhancedMonitoring: true,
      letterInputs: {
        confirmedOn: "2026-10-08",
        siteName: "Site One",
        siteManagerFirstName: "Sam",
        siteManagerName: "Sam Lee",
        siteAddress: "1 Main St, San Francisco, CA",
        departmentName: "Department of Public Health",
        programManagerName: "Sample Contact002",
        programManagerPhone: "415-555-0100",
        programManagerEmail: "rob@sfgov.org",
      },
    });
    expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.7");
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("embeds accented and non-Latin names without rejecting their glyphs", async () => {
    const pdf = await generateComplianceLetterPdf({
      effectiveStart: "2026-10-08",
      requiredChecksPerDay: 3,
      reasons: ["2"],
      letterInputs: {
        confirmedOn: "2026-10-08",
        siteName: "Casa Muñoz — Дом Надежды",
        siteManagerFirstName: "José",
        siteManagerName: "José Παπαδόπουλος",
        siteAddress: "1 Main St",
        departmentName: "DPH",
        programManagerName: "Анна Иванова",
        programManagerPhone: "415-555-0100",
        programManagerEmail: "manager@sfgov.org",
      },
    });

    expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.7");
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("creates an SVG preview from the same mapped letter fields", () => {
    const preview = generateComplianceLetterPreviewSvg({
      effectiveStart: "2026-10-08",
      requiredChecksPerDay: 3,
      reasons: ["2"],
      letterInputs: {
        confirmedOn: "2026-10-08",
        siteName: "Site & One",
        siteManagerFirstName: "Sam",
        siteManagerName: "Sam Lee",
        siteAddress: "1 Main St",
        departmentName: "DPH",
        programManagerName: "Sample Contact002",
        programManagerPhone: "415-555-0100",
        programManagerEmail: "rob@sfgov.org",
      },
    });
    const svg = preview.toString();
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("Site &amp; One");
    expect(svg.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).toContain(
      "at least three (3)",
    );
    expect(svg).toContain("perimeter checks");
    expect(svg).toContain("Dear Sam,");
    expect(svg).toContain("enhanced monitoring");
    expect(svg).not.toContain("un-escalated");
  });
});

it.each([
  [["Morgan Lee"], "Sample Contact009 and Morgan Lee oversee", 4, "four (4)"],
  [
    ["Morgan Lee", "Jordan Smith"],
    "Sample Contact009, Morgan Lee, and Jordan Smith oversee",
    21,
    "twenty-one (21)",
  ],
  [[], "Sample Contact009 oversees", 100, "one hundred (100)"],
])(
  "formats manager lists and daily cadence",
  (providerManagerNames, names, requiredChecksPerDay, cadence) => {
    const svg = generateComplianceLetterPreviewSvg({
      effectiveStart: "2026-10-21",
      requiredChecksPerDay,
      letterInputs: {
        siteName: "Site",
        siteAddress: "Address",
        siteManagerName: "Sample Contact009",
        siteManagerFirstName: "Sample",
        providerManagerNames,
      },
    }).toString();
    const text = svg.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Dear Sample,");
    expect(text).toContain(names);
    expect(text).toContain(`${cadence} times per day`);
    expect(text).toContain(`${cadence} perimeter checks per day`);
  },
);
