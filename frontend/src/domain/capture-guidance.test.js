import { describe, expect, it } from "vitest";
import { captureGuidance, startingGuidance } from "./capture-guidance.js";

const photo = (shotType) => ({
  id: "photo",
  kind: "photo",
  analysis: { sourceAnalysis: { shotType } },
});
const guidance = (...types) =>
  captureGuidance({ items: types.map(photo) }, "check.title.third");
const completed = (day, extra = {}) => ({
  status: "completed",
  flowType: "perimeter",
  completedAt: `2026-10-${String(day).padStart(2, "0")}T18:00:00Z`,
  ...extra,
});
const start = "2026-10-13T19:00:00Z";

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
    for (const count of [0, 1, 3, 4]) {
      expect(
        startingGuidance(
          Array.from({ length: count }, () => completed(13)),
          start,
          "new",
        ).titleKey,
      ).toBe("check.title");
    }
    expect(
      startingGuidance([completed(13), completed(13)], start, "new").titleKey,
    ).toBe("check.title.third");
  });
  it("counts completion day across devices, excluding reports, drafts, and this check", () => {
    const headers = [
      completed(13, { startedAt: "2026-10-12T18:00:00Z", deviceId: "a" }),
      completed(13, { deviceId: "b" }),
      completed(13, { flowType: "single-problem" }),
      completed(13, { status: "in_progress" }),
      completed(13, { checkId: "new" }),
    ];
    expect(startingGuidance(headers, start, "new").titleKey).toBe(
      "check.title.third",
    );
  });
  it("uses Pacific completion days around midnight", () => {
    const headers = [
      completed(13, { completedAt: "2026-10-13T06:59:59Z" }),
      completed(13),
    ];
    expect(startingGuidance(headers, start, "new").titleKey).toBe(
      "check.title",
    );
  });
  it("celebrates only the first check on day four", () => {
    const streak = [10, 11, 12].flatMap((day) =>
      Array.from({ length: 3 }, () => completed(day)),
    );
    expect(startingGuidance(streak, start, "new").titleKey).toBe(
      "check.title.fourDays",
    );
    expect(
      startingGuidance([...streak, completed(13)], start, "new").titleKey,
    ).toBe("check.title");
    const dayFive = [
      ...streak,
      ...Array.from({ length: 3 }, () => completed(9)),
    ];
    expect(startingGuidance(dayFive, start, "new").titleKey).toBe(
      "check.title",
    );
    expect(startingGuidance(streak.slice(1), start, "new").titleKey).toBe(
      "check.title",
    );
  });
});
