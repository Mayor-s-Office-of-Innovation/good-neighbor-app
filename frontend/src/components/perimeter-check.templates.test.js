import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RECOMMENDED_PERIMETER_PHOTOS } from "../domain/check-completion.js";
import { t } from "../i18n/i18n.js";
import {
  descriptionCard,
  footer,
  photoGrid,
  progressLine,
  shell,
} from "./perimeter-check.templates.js";

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

describe("shell", () => {
  it("renders the photo roll, the describe button, and no place controls", () => {
    const markup = shell();

    expect(markup).toContain('id="shotgrid"');
    expect(markup).toContain('id="describe-instead"');
    expect(markup).toContain('id="check-progress"');
    expect(markup).not.toContain("place-row");
    expect(markup).not.toContain("Add place");
  });
});

describe("progressLine", () => {
  it("counts photos toward the minimum and offers the text alternative", () => {
    const markup = progressLine({ photos: 2 });

    expect(markup).toContain(
      t("check.progress.count", {
        photos: 2,
        recommended: RECOMMENDED_PERIMETER_PHOTOS,
      }),
    );
    expect(markup).toContain(t("check.progress.hint"));
  });

  it("does not add a completion label once the photo minimum is met", () => {
    const markup = progressLine({ photos: 1 });

    expect(markup).toContain(
      t("check.progress.count", { photos: 1, recommended: 3 }),
    );
    expect(markup).not.toContain("Ready to finish");
  });

  it("keeps the photo guidance without a saved-description status", () => {
    const markup = progressLine({ photos: 0 });

    expect(markup).toContain(
      t("check.progress.count", { photos: 0, recommended: 3 }),
    );
    expect(markup).toContain(t("check.progress.hint"));
    expect(markup).not.toContain("Description saved");
    expect(markup).not.toContain("Ready to finish");
  });
});

describe("descriptionCard", () => {
  it("renders nothing without a description", () => {
    expect(descriptionCard(null)).toBe("");
    expect(descriptionCard(undefined)).toBe("");
  });

  it("renders the escaped text with edit and remove controls", () => {
    const markup = descriptionCard({
      id: "text-1",
      text: "Litter <near> the door & sidewalk",
    });

    expect(markup).toContain("Litter &lt;near&gt; the door &amp; sidewalk");
    expect(markup).toContain('class="shot shot--description"');
    expect(markup).toContain('class="shot__del shot__edit"');
    expect(markup).toContain('class="shot__del"');
    expect(markup).toContain(`aria-label="${t("check.description.edit")}"`);
    expect(markup).toContain(`aria-label="${t("check.description.delete")}"`);
    expect(markup).toContain('data-edit-description="text-1"');
    expect(markup).toContain('data-remove-description="text-1"');
  });
});

describe("photoGrid", () => {
  it("renders the camera first with the newest photo immediately after it", () => {
    const markup = photoGrid([
      { id: "first", dataUrl: "data:first" },
      { id: "second", dataUrl: "data:second" },
    ]);

    expect(markup.indexOf('id="add-photo"')).toBeLessThan(
      markup.indexOf('data-del="second"'),
    );
    expect(markup.indexOf('data-del="second"')).toBeLessThan(
      markup.indexOf('data-del="first"'),
    );
    expect(markup).not.toContain("addshot--empty");
  });

  it("renders the empty add tile when there are no photos", () => {
    const markup = photoGrid([]);

    expect(markup).toContain("addshot--empty");
    expect(markup).toContain(t("check.photo.take"));
    expect(markup).toContain('name="camera"');
  });

  it("renders a description immediately after the camera tile", () => {
    const markup = photoGrid([{ id: "photo-1", dataUrl: "data:photo" }], {
      id: "text-1",
      text: "Litter near the entrance",
    });

    expect(markup.indexOf('id="add-photo"')).toBeLessThan(
      markup.indexOf('data-edit-description="text-1"'),
    );
    expect(markup.indexOf('data-edit-description="text-1"')).toBeLessThan(
      markup.indexOf('data-del="photo-1"'),
    );
    expect(markup).not.toContain("addshot--empty");
  });
});

describe("footer", () => {
  it("disables Finish until the completion rule is met", () => {
    const markup = footer({ items: [], analyzingOpen: false, complete: false });

    expect(markup).toMatch(/id="done-check"[^>]*disabled/);
    expect(markup).not.toContain('id="toggle-analyzing"');
  });

  it("enables Finish once complete and shows the analyzing toggle", () => {
    const markup = footer({
      items: [{ id: "photo-1", kind: "photo", analysis: { status: "queued" } }],
      analyzingOpen: false,
      complete: true,
    });

    expect(markup).not.toMatch(/id="done-check"[^>]*disabled/);
    expect(markup).toContain('id="toggle-analyzing"');
    expect(markup).toContain(t("card.pending.title"));
  });
});
