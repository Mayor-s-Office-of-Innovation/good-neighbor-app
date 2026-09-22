import { describe, expect, it } from "vitest";

import {
  MIN_DESCRIPTION_LENGTH,
  MIN_PERIMETER_PHOTOS,
  canSubmitDescription,
  checkItems,
  completionStatus,
  hasEvidence,
  isPerimeterCheckComplete,
  itemCountsTowardCompletion,
  photoCount,
  textCount,
} from "./check-completion.js";

/**
 * @param {number} photos
 * @param {number} texts
 */
function makeCheck(photos, texts) {
  const items = [];
  for (let i = 0; i < photos; i += 1) {
    items.push({ id: `photo-${i}`, kind: "photo", dataUrl: "data:," });
  }
  for (let i = 0; i < texts; i += 1) {
    items.push({ id: `text-${i}`, kind: "text", text: "A description." });
  }
  return {
    placeOrder: ["perimeter"],
    places: { perimeter: { id: "perimeter", name: "Site", items } },
  };
}

describe("isPerimeterCheckComplete", () => {
  it("is incomplete with four photos and no description", () => {
    expect(isPerimeterCheckComplete(makeCheck(4, 0))).toBe(false);
  });

  it("is complete with five photos", () => {
    expect(isPerimeterCheckComplete(makeCheck(5, 0))).toBe(true);
    expect(MIN_PERIMETER_PHOTOS).toBe(5);
  });

  it("is complete with zero photos and one description", () => {
    expect(isPerimeterCheckComplete(makeCheck(0, 1))).toBe(true);
  });

  it("is complete with two photos and one description", () => {
    expect(isPerimeterCheckComplete(makeCheck(2, 1))).toBe(true);
  });

  it("is incomplete for an empty or missing check", () => {
    expect(isPerimeterCheckComplete(makeCheck(0, 0))).toBe(false);
    expect(isPerimeterCheckComplete(null)).toBe(false);
    expect(isPerimeterCheckComplete({})).toBe(false);
  });
});

describe("itemCountsTowardCompletion (live evidence only)", () => {
  const DEAD_PHOTO = {
    id: "dead",
    kind: "photo",
    dataUrl: "data:,",
    upload: { status: "failed" },
    analysis: { status: "failed" },
  };
  const REGISTERED_BUT_FAILED = {
    id: "reg-dead",
    kind: "photo",
    upload: { status: "uploaded", artifactId: "art-1" },
    analysis: { status: "failed", artifactId: "art-1" },
  };
  const IN_FLIGHT = {
    id: "flying",
    kind: "text",
    text: "Still being processed.",
    analysis: { status: "analyzing" },
  };

  it("a registered item counts even when its analysis failed", () => {
    // The backend artifact exists — the coverage gate knows it and the
    // analysis failed marker satisfies the backend gate too.
    expect(itemCountsTowardCompletion(REGISTERED_BUT_FAILED)).toBe(true);
  });

  it("a permanently failed item with no registered artifact does not count", () => {
    expect(itemCountsTowardCompletion(DEAD_PHOTO)).toBe(false);
  });

  it("an in-flight item (idle/queued/analyzing) counts", () => {
    expect(itemCountsTowardCompletion(IN_FLIGHT)).toBe(true);
    expect(itemCountsTowardCompletion({ id: "new", kind: "photo" })).toBe(true);
    expect(
      itemCountsTowardCompletion({
        id: "q",
        kind: "photo",
        analysis: { status: "queued" },
      }),
    ).toBe(true);
  });

  it("five failed uploads do NOT satisfy the five-photo rule", () => {
    const check = makeCheck(0, 0);
    check.places.perimeter.items = Array.from({ length: 5 }, (_, i) => ({
      ...DEAD_PHOTO,
      id: `dead-${i}`,
    }));
    expect(photoCount(check)).toBe(0);
    expect(isPerimeterCheckComplete(check)).toBe(false);
    expect(completionStatus(check)).toEqual({
      photos: 0,
      texts: 0,
      complete: false,
      remaining: 5,
    });
  });

  it("five failed uploads plus four live photos count only four", () => {
    const check = makeCheck(0, 0);
    check.places.perimeter.items = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `dead-${i}`,
        kind: "photo",
        dataUrl: "data:,",
        upload: { status: "failed" },
        analysis: { status: "failed" },
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `live-${i}`,
        kind: "photo",
        dataUrl: "data:,",
      })),
    ];
    expect(photoCount(check)).toBe(4);
    expect(isPerimeterCheckComplete(check)).toBe(false);
  });

  it("a failed description with no artifact does not satisfy the one-description rule", () => {
    const check = makeCheck(0, 0);
    check.places.perimeter.items = [
      /** @type {any} */ ({
        id: "dead-text",
        kind: "text",
        text: "Never registered.",
        upload: { status: "failed" },
        analysis: { status: "failed" },
      }),
    ];
    expect(textCount(check)).toBe(0);
    expect(isPerimeterCheckComplete(check)).toBe(false);
  });

  it("hasEvidence still sees dead items (cancel/discard decisions)", () => {
    const check = makeCheck(0, 0);
    check.places.perimeter.items = [
      { ...DEAD_PHOTO, id: "dead-1" },
      { ...DEAD_PHOTO, id: "dead-2" },
    ];
    expect(hasEvidence(check)).toBe(true);
    expect(photoCount(check)).toBe(0);
  });
});

describe("counts and status", () => {
  it("counts photos and texts across every place in order", () => {
    const check = {
      placeOrder: ["b", "a"],
      places: {
        a: { items: [{ id: "a1", kind: "photo" }] },
        b: {
          items: [
            { id: "b1", kind: "text" },
            { id: "b2", kind: "photo" },
          ],
        },
      },
    };
    expect(checkItems(check).map((item) => item.id)).toEqual([
      "b1",
      "b2",
      "a1",
    ]);
    expect(photoCount(check)).toBe(2);
    expect(textCount(check)).toBe(1);
    expect(hasEvidence(check)).toBe(true);
    expect(hasEvidence(makeCheck(0, 0))).toBe(false);
  });

  it("reports remaining photos until the minimum is met", () => {
    expect(completionStatus(makeCheck(3, 0))).toEqual({
      photos: 3,
      texts: 0,
      complete: false,
      remaining: 2,
    });
    expect(completionStatus(makeCheck(7, 0)).remaining).toBe(0);
    expect(completionStatus(makeCheck(0, 1)).complete).toBe(true);
  });
});

describe("canSubmitDescription", () => {
  it("requires the minimum trimmed length", () => {
    const short = "x".repeat(MIN_DESCRIPTION_LENGTH - 1);
    const enough = "x".repeat(MIN_DESCRIPTION_LENGTH);
    expect(canSubmitDescription(short)).toBe(false);
    expect(canSubmitDescription(`  ${short}  `)).toBe(false);
    expect(canSubmitDescription(enough)).toBe(true);
    expect(canSubmitDescription(`  ${enough}  `)).toBe(true);
    expect(canSubmitDescription(null)).toBe(false);
  });
});
