import { describe, expect, it } from "vitest";

import {
  canSubmitTextDescription,
  orderedPhotoItems,
  placeRow,
} from "./perimeter-check.templates.js";

describe("orderedPhotoItems", () => {
  it("renders captured photos newest-first after the add-photo tile", () => {
    expect(
      orderedPhotoItems([
        { id: "oldest", kind: "photo" },
        { id: "typed-note", kind: "text" },
        { id: "middle", kind: "photo" },
        { id: "newest", kind: "photo" },
      ]).map((item) => item.id),
    ).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("placeRow", () => {
  it("renders text-mode save before switching back to photo mode", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [],
        inputMode: "text",
        draftText: "Some leaves near the doorway.",
      },
      index: 0,
      expanded: true,
      isLast: true,
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain('data-review-text="place-1"');
    expect(markup).not.toContain(
      'data-review-text="place-1"\n        disabled',
    );
    expect(markup.indexOf("Save changes")).toBeLessThan(
      markup.indexOf("Take a photo instead"),
    );
  });

  it("disables text-mode save until text is entered", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [],
        inputMode: "text",
        draftText: "   ",
      },
      index: 0,
      expanded: true,
      isLast: true,
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain("Save changes");
    expect(markup).toContain("disabled");
  });

  it("requires at least five trimmed characters before text can submit", () => {
    expect(canSubmitTextDescription("abcd")).toBe(false);
    expect(canSubmitTextDescription(" abc ")).toBe(false);
    expect(canSubmitTextDescription("abcde")).toBe(true);
    expect(canSubmitTextDescription("  abcde  ")).toBe(true);
  });
});
