import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  addPlaceButton,
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

describe("self-hosted icons", () => {
  it("includes the sparkle asset used by pending-analysis placeholders", () => {
    expect(
      existsSync(new URL("../../public/icons/sparkles.svg", import.meta.url)),
    ).toBe(true);
  });

  it("includes the logout asset used by the settings menu", () => {
    expect(
      existsSync(
        new URL(
          "../../public/icons/arrow-right-from-bracket.svg",
          import.meta.url,
        ),
      ),
    ).toBe(true);
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
    expect(markup.indexOf("Save note")).toBeLessThan(
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

    expect(markup).toContain("Save note");
    expect(markup).toContain("disabled");
  });

  it("labels submitted-photo advance with the next place name", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [{ id: "photo-1", kind: "photo" }],
        inputMode: "photo",
      },
      index: 0,
      expanded: true,
      isLast: false,
      nextPlaceName: "Side alley",
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain("Continue to Side alley");
    expect(markup).not.toContain("Next place");
  });

  it("waits to show the check mark until a place has been continued", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [{ id: "photo-1", kind: "photo" }],
        reviewed: false,
      },
      index: 0,
      expanded: false,
      isLast: false,
      nextPlaceName: "Side alley",
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).not.toContain("place-row__check");
    expect(markup).not.toContain("place-row__step--done");
    expect(markup).not.toContain('class="visually-hidden"');
  });

  it("shows a check mark after submitted evidence is continued", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [{ id: "photo-1", kind: "photo" }],
        reviewed: true,
      },
      index: 0,
      expanded: false,
      isLast: false,
      nextPlaceName: "Side alley",
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain("place-row__step--done");
    expect(markup).toContain("place-row__check");
    expect(markup).toContain("place-row__line--done");
    expect(markup).toContain('<span class="visually-hidden">, Reviewed</span>');
  });

  it("continues a reviewed place with a validated description and no items", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [],
        description: { validated: true },
        reviewed: true,
      },
      index: 0,
      expanded: true,
      isLast: false,
      nextPlaceName: "Side alley",
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain("place-row__step--done");
    expect(markup).toContain("Continue to Side alley");
    expect(markup).toContain("btn-pill--continue");
  });

  it("renders condition labels with flag icons", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [{ id: "photo-1", kind: "photo" }],
        conditionLabels: ["Waste & Small Debris"],
      },
      index: 0,
      expanded: false,
      isLast: false,
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain('name="flag"');
    expect(markup).toContain("Waste &amp; Small Debris");
    expect(markup).not.toContain('name="sparkles"');
  });

  it("renders a pending issue skeleton for collapsed places still analyzing", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [
          {
            id: "photo-1",
            kind: "photo",
            analysis: { status: "analyzing" },
          },
        ],
      },
      index: 0,
      expanded: false,
      isLast: false,
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain("place-row__pending-issue");
    expect(markup).toContain('name="sparkles"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Issue-label analysis in progress");
  });

  it("keeps pending issue skeleton out of the expanded capture controls", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [
          {
            id: "photo-1",
            kind: "photo",
            analysis: { status: "queued" },
          },
        ],
      },
      index: 0,
      expanded: true,
      isLast: false,
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).not.toContain("place-row__pending-issue");
  });

  it("shows a minus for skipped places", () => {
    const markup = placeRow({
      place: {
        id: "place-1",
        name: "Front entrance",
        items: [],
        skipped: true,
      },
      index: 0,
      expanded: false,
      isLast: false,
      nextPlaceName: "Side alley",
      openMenuItemId: null,
      photoMenuAnchor: null,
    });

    expect(markup).toContain("place-row__step--skipped");
    expect(markup).toContain("place-row__minus");
    expect(markup).toContain("place-row__line--done");
    expect(markup).toContain(
      '<span class="visually-hidden">, Skipped for now</span>',
    );
  });

  it("requires at least five trimmed characters before text can submit", () => {
    expect(canSubmitTextDescription("abcd")).toBe(false);
    expect(canSubmitTextDescription(" abc ")).toBe(false);
    expect(canSubmitTextDescription("abcde")).toBe(true);
    expect(canSubmitTextDescription("  abcde  ")).toBe(true);
  });
});

describe("addPlaceButton", () => {
  it("renders the visible add-place label", () => {
    const markup = addPlaceButton();

    expect(markup).toContain('id="add-place-open"');
    expect(markup).toContain("Add place");
    expect(markup).not.toContain("visually-hidden");
  });
});
