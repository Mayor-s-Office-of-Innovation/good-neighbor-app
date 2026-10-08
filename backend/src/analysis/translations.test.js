import { describe, expect, it } from "vitest";
import {
  TRANSLATION_TARGET_LOCALES,
  mergeTranslations,
  missingTranslationLocales,
  normalizeTranslations,
  translationsEqual,
} from "./translations.js";

describe("normalizeTranslations", () => {
  it("upgrades the analyzer's single block to a per-locale map", () => {
    expect(
      normalizeTranslations({
        language: "es",
        user_friendly_label: " Basura ",
        description: "Envolturas",
      }),
    ).toEqual({
      es: { user_friendly_label: "Basura", description: "Envolturas" },
    });
  });

  it("keeps a map, dropping entries with no usable text", () => {
    expect(
      normalizeTranslations({
        es: { user_friendly_label: "Basura" },
        vi: { user_friendly_label: "", description: 7 },
        fil: "not an object",
        "": { description: "x" },
      }),
    ).toEqual({ es: { user_friendly_label: "Basura" } });
  });

  it("returns undefined for malformed or empty input", () => {
    for (const value of [
      undefined,
      null,
      "es",
      [],
      {},
      { language: 7 },
      { language: "es" },
      { language: "es", user_friendly_label: 42 },
      { user_friendly_label: "no language" },
    ]) {
      expect(normalizeTranslations(value)).toBeUndefined();
    }
  });
});

describe("mergeTranslations", () => {
  it("merges per locale, incoming entries replacing prior ones", () => {
    expect(
      mergeTranslations(
        { language: "es", user_friendly_label: "Viejo", description: "a" },
        { es: { user_friendly_label: "Nuevo" }, fil: { description: "b" } },
      ),
    ).toEqual({
      es: { user_friendly_label: "Nuevo" },
      fil: { description: "b" },
    });
  });

  it("falls back to whichever side has content", () => {
    const es = { es: { user_friendly_label: "x" } };
    expect(mergeTranslations(undefined, es)).toEqual(es);
    expect(mergeTranslations(es, undefined)).toEqual(es);
    expect(mergeTranslations(undefined, undefined)).toBeUndefined();
  });
});

describe("missingTranslationLocales", () => {
  it("lists every target locale with no entry", () => {
    expect(TRANSLATION_TARGET_LOCALES).toEqual(["es", "fil", "vi", "zh-Hant"]);
    expect(missingTranslationLocales(undefined)).toEqual([
      "es",
      "fil",
      "vi",
      "zh-Hant",
    ]);
    expect(
      missingTranslationLocales({
        es: { user_friendly_label: "x" },
        "zh-Hant": { description: "y" },
      }),
    ).toEqual(["fil", "vi"]);
    expect(
      missingTranslationLocales({ language: "vi", description: "z" }, ["vi"]),
    ).toEqual([]);
  });
});

describe("translationsEqual", () => {
  it("compares normalized content regardless of shape or key order", () => {
    expect(
      translationsEqual(
        { language: "es", description: "a", user_friendly_label: "b" },
        { es: { user_friendly_label: "b", description: "a" } },
      ),
    ).toBe(true);
    expect(translationsEqual(undefined, { language: "es" })).toBe(true);
    expect(
      translationsEqual(
        { es: { description: "a" } },
        { es: { description: "b" } },
      ),
    ).toBe(false);
  });
});
