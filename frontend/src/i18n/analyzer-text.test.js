import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n.js";
import { analyzerTranslation } from "./analyzer-text.js";

afterEach(async () => {
  await setLocale("en");
});

const map = {
  translations: {
    es: { user_friendly_label: "Basura", description: "Envolturas" },
    vi: { user_friendly_label: "Rác" },
  },
};
const legacy = {
  translations: { language: "es", user_friendly_label: "Basura" },
};

describe("analyzerTranslation", () => {
  it("reads the active locale's entry from the per-locale map", async () => {
    await setLocale("es");
    expect(analyzerTranslation(map, "user_friendly_label")).toBe("Basura");
    expect(analyzerTranslation(map, "description")).toBe("Envolturas");
    await setLocale("vi");
    expect(analyzerTranslation(map, "user_friendly_label")).toBe("Rác");
    expect(analyzerTranslation(map, "description")).toBeUndefined();
  });

  it("still reads a record stored in the single-block shape", async () => {
    await setLocale("es");
    expect(analyzerTranslation(legacy, "user_friendly_label")).toBe("Basura");
    await setLocale("fil");
    expect(analyzerTranslation(legacy, "user_friendly_label")).toBeUndefined();
  });

  it("returns undefined in English and for records without translations", async () => {
    expect(analyzerTranslation(map, "user_friendly_label")).toBeUndefined();
    expect(analyzerTranslation({}, "description")).toBeUndefined();
    expect(analyzerTranslation(undefined, "description")).toBeUndefined();
    expect(
      analyzerTranslation({ translations: "es" }, "description"),
    ).toBeUndefined();
  });
});
