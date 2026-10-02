import { afterEach, describe, expect, it } from "vitest";

import en from "./catalogs/en.json";
import { hasKey, setLocale, t } from "./i18n.js";
import { rulebookKey, rulebookOptionLabel, rulebookText } from "./rulebook.js";

const entries = Object.entries(en).filter(([k]) => k.startsWith("rulebook."));
const [sampleKey, sampleText] =
  entries.find(([k]) => k.startsWith("rulebook.button.")) ?? [];

afterEach(async () => {
  await setLocale("en");
});

describe("rulebook lookup", () => {
  it("has a generated namespace to look up", () => {
    expect(entries.length).toBeGreaterThan(50);
    expect(sampleKey).toBeTruthy();
  });

  it("resolves stored English rulebook text to its key and translation", async () => {
    expect(rulebookKey(sampleText)).toBe(sampleKey);
    expect(rulebookText(sampleText)).toBe(t(sampleKey));
    expect(rulebookKey(`  ${sampleText}  `)).toBe(sampleKey);
    await setLocale("es");
    expect(rulebookText(sampleText)).toBe(t(sampleKey));
  });

  it("disambiguates duplicate English by scope", async () => {
    expect(rulebookKey("Resolved", "server.sf311")).toMatch(
      /^server\.sf311\.closure\./,
    );
    expect(rulebookKey("Resolved", "server.taskUpdate")).toMatch(
      /^server\.taskUpdate\./,
    );
    await setLocale("es");
    expect(rulebookText("Resolved", "server.sf311")).toBe(
      t(rulebookKey("Resolved", "server.sf311")),
    );
    expect(rulebookText("resolved", "server.sf311")).toBe(
      t(rulebookKey("Resolved", "server.sf311")).toLowerCase(),
    );
  });

  it("is a no-op in English", () => {
    expect(rulebookText("  File 311 ticket  ")).toBe("  File 311 ticket  ");
  });

  it("passes unknown or empty text through unchanged", () => {
    expect(rulebookText("Something the rulebook never said")).toBe(
      "Something the rulebook never said",
    );
    expect(rulebookText("")).toBe("");
    expect(rulebookText(undefined)).toBe("");
    expect(rulebookKey(42)).toBeNull();
  });

  it("also resolves backend server text, matching case-insensitively", async () => {
    expect(rulebookKey("Closed")).toMatch(/^server\.sf311\.status\./);
    expect(rulebookKey("Updated with photos")).toMatch(/^server\.taskUpdate\./);
    // The backend lower-cases a closure reason inside "Closed: resolved".
    expect(rulebookKey("resolved")).toBe(rulebookKey("Resolved"));
    await setLocale("es");
    expect(rulebookText("resolved")).toBe(
      t(rulebookKey("Resolved")).toLowerCase(),
    );
    expect(rulebookText("Resolved")).toBe(t(rulebookKey("Resolved")));
    expect(hasKey("server.sf311.eventTitle.statusChanged")).toBe(true);
  });

  it("covers every category, agency, question, and yes/no option", () => {
    const fields = new Set(entries.map(([k]) => k.split(".")[1]));
    for (const field of [
      "category",
      "agency",
      "label",
      "guidance",
      "button",
      "cannotDo",
      "question",
      "option",
    ]) {
      expect(fields.has(field), field).toBe(true);
    }
    expect(rulebookOptionLabel({ label: "Yes", value: true })).toBe(
      t(rulebookKey("Yes")),
    );
    expect(rulebookOptionLabel({ value: false })).toBe("false");
    expect(rulebookOptionLabel(null)).toBe("");
  });
});
