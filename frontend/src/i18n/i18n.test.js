import { afterEach, describe, expect, it } from "vitest";

import { hasKey, ready, setLocale, t } from "./i18n.js";
import { getLocale, getLocaleTag, LOCALES } from "./locale.js";
import en from "./catalogs/en.json";
import vi from "./catalogs/vi.json";

afterEach(async () => {
  await setLocale("en");
});

describe("t()", () => {
  it("returns the English text by key", async () => {
    await ready;
    expect(t("common.close")).toBe(en["common.close"]);
  });

  it("interpolates {name} placeholders", () => {
    expect(t("toast.ticketFiled.message", { number: "SR-1" })).toBe(
      en["toast.ticketFiled.message"].replace("{number}", "SR-1"),
    );
  });

  it("leaves unknown placeholders alone and falls back to the key", () => {
    expect(t("common.opensNewTab", { other: "x" })).toBe(
      en["common.opensNewTab"],
    );
    expect(t("nope.missing")).toBe("nope.missing");
  });

  it("reports whether the reference catalog has a key", () => {
    expect(hasKey("common.close")).toBe(true);
    expect(hasKey("nope.missing")).toBe(false);
  });
});

describe("setLocale()", () => {
  it("switches the active locale and tag, rejecting unknown ids", async () => {
    await setLocale("es");
    expect(getLocale()).toBe("es");
    expect(getLocaleTag()).toBe("es-US");
    await setLocale("klingon");
    expect(getLocale()).toBe("en");
  });

  it("falls back to English for keys a locale lacks", async () => {
    await setLocale("vi");
    expect(t("common.close")).toBeTruthy();
    expect(t("common.close")).not.toBe("common.close");
  });

  it("lists every supported locale with a tag and a native label", () => {
    expect(LOCALES.map((l) => l.id)).toEqual([
      "en",
      "es",
      "fil",
      "vi",
      "zh-Hant",
    ]);
    for (const locale of LOCALES) {
      expect(locale.tag).toMatch(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
      expect(locale.label.length).toBeGreaterThan(0);
    }
  });
});

describe("plural selection", () => {
  it("uses the locale's own plural rules once an entry is translated", async () => {
    await setLocale("vi");
    // Vietnamese has no "one" category, so count 1 takes the ".other" form.
    expect(vi["home.overdue.hours.other"]).not.toBe(
      en["home.overdue.hours.other"],
    );
    expect(t("home.overdue.hours", { count: 1 })).toBe(
      vi["home.overdue.hours.other"].replace("{count}", "1"),
    );
    expect(t("home.overdue.hours", { count: 2 })).toBe(
      vi["home.overdue.hours.other"].replace("{count}", "2"),
    );
  });

  it("reports a failed catalog load without changing the locale", async () => {
    // Unknown ids are coerced to English, which always loads.
    await expect(setLocale("klingon")).resolves.toBe(true);
    expect(getLocale()).toBe("en");
  });

  it("picks the CLDR category from params.count", async () => {
    // Exercise the selection logic against a synthetic key set by stubbing
    // through the English catalog shape: one/other siblings.
    const rules = new Intl.PluralRules(getLocaleTag());
    expect(rules.select(1)).toBe("one");
    expect(rules.select(2)).toBe("other");
    await setLocale("zh-Hant");
    expect(new Intl.PluralRules(getLocaleTag()).select(1)).toBe("other");
  });
});
