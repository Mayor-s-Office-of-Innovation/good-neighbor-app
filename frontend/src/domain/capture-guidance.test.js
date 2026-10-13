import { describe, expect, it } from "vitest";
import { captureGuidance, startingGuidance } from "./capture-guidance.js";

const photo = (shotType) => ({
  id: "photo",
  kind: "photo",
  analysis: { sourceAnalysis: { shotType } },
});
const guidance = (...types) =>
  captureGuidance({ items: types.map(photo) }, "check.title.third");
describe("capture titles", () => {
  it("retains the starting title until framing guidance applies", () => {
    expect(guidance().titleKey).toBe("check.title.third");
    expect(guidance("wide").titleKey).toBe("check.title.third");
    expect(guidance("detail", "wide", "detail").titleKey).toBe(
      "check.title.third",
    );
  });
  it.each([
    ["detail", "check.title.needWide"],
    ["wide", "check.title.needDetail"],
  ])("requests complementary coverage after two %s shots", (type, titleKey) => {
    expect(guidance(type, type).titleKey).toBe(titleKey);
    expect(guidance(type, type, type).titleKey).toBe(titleKey);
    expect(guidance(type, type, undefined).titleKey).toBe(titleKey);
  });
  it("acknowledges the requested complementary shot", () => {
    expect(guidance("detail", "detail", "wide").titleKey).toBe(
      "check.title.greatShot",
    );
    expect(guidance("wide", "wide", "detail").titleKey).toBe(
      "check.title.greatShot",
    );
  });
  it("four photos override every other title, including pending classifications", () => {
    expect(guidance(undefined, undefined, undefined, undefined).titleKey).toBe(
      "check.title.extra",
    );
    expect(guidance("detail", "detail", "detail", "detail").titleKey).toBe(
      "check.title.extra",
    );
  });
  it("excludes failed uploads but counts registered photos with failed analysis", () => {
    const result = captureGuidance({
      items: [
        photo("wide"),
        {
          id: "failed",
          kind: "photo",
          upload: { status: "failed" },
          analysis: { status: "failed" },
        },
        {
          id: "failed",
          kind: "photo",
          analysis: { status: "failed", artifactId: "registered" },
        },
        { id: "text", kind: "text" },
      ],
    });
    expect(result).toMatchObject({ photos: 2, wide: 1, detail: 0 });
  });
  it("recalculates after removal rather than retaining a satisfied prompt", () => {
    const items = [
      photo("detail"),
      photo("detail"),
      photo("wide"),
      photo(undefined),
    ];
    expect(captureGuidance({ items }).titleKey).toBe("check.title.extra");
    expect(captureGuidance({ items: items.slice(0, 3) }).titleKey).toBe(
      "check.title.greatShot",
    );
    expect(captureGuidance({ items: items.slice(0, 2) }).titleKey).toBe(
      "check.title.needWide",
    );
    expect(captureGuidance({ items: items.slice(0, 1) }).titleKey).toBe(
      "check.title",
    );
  });
});

describe("starting titles", () => {
  it("uses the default except on the third check", () => {
    for (const today of [0, 1, 3, 4])
      expect(startingGuidance([today, 0, 0, 0, 0]).titleKey).toBe(
        "check.title",
      );
    expect(startingGuidance([2, 0, 0, 0, 0]).titleKey).toBe(
      "check.title.third",
    );
  });
  it("celebrates only the first check on day four", () => {
    expect(startingGuidance([0, 3, 3, 3, 0]).titleKey).toBe(
      "check.title.fourDays",
    );
    expect(startingGuidance([0, 4, 3, 5, 2]).titleKey).toBe(
      "check.title.fourDays",
    );
    for (const counts of [
      [1, 3, 3, 3, 0],
      [0, 3, 3, 3, 3],
      [0, 3, 2, 3, 0],
    ]) {
      expect(startingGuidance(counts).titleKey).toBe("check.title");
    }
  });
});
