// @ts-check
import { test, expect } from "../helpers/harness.js";
import {
  dismissAllNewResults,
  finishCheck,
  startCheck,
} from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";

/*
  Perimeter check with text evidence instead of photos, end to end, against
  the local harness with the analyzer stub.

  Text is a full alternative to photos (docs/plan-remove-places.md): one saved
  description of the whole perimeter satisfies the completion rule on its own,
  so staff who cannot take photos can still finish a check.

  - Start a check → Finish is disabled with zero photos.
  - "Describe instead" → /check/describe; Continue stays disabled until the
    text reaches the perimeter minimum (MIN_DESCRIPTION_LENGTH = 20 trimmed
    characters).
  - Unsaved close → an opaque, labeled discard dialog; keep editing returns to
    the draft.
  - Continue → back on the capture screen with the description tile and Finish
    enabled with zero photos; "Describe instead" remains available.
  - The description registers as a text artifact (no S3 leg) and the worker
    sends it to the stub as text media; the stub serves the selected fixture
    for every /v1/analyses call regardless of media kind, so "multi" yields
    task cards from the text analysis.
  - Finish → home → NEW task cards appear in the results tray → dismiss every
    generated card via its delete (trash) button + confirm.
*/

const SHORT_TEXT = "Trash by door";
const DESCRIPTION =
  "Sidewalks are clear on both sides. There is trash near the entrance and " +
  "graffiti on the wall, plus a tent against the side of the building.";

test.describe("describe instead", () => {
  test("one description completes a check with zero photos and yields task cards", async ({
    page,
  }) => {
    await startCheck(page);
    const done = page.locator("#done-check");
    const progress = page.locator("#check-progress");

    // Zero photos, no description: the rule is not met.
    await expect(page.locator(".shot img")).toHaveCount(0);
    await expect(done).toBeDisabled();

    // The text artifact is analyzed like a photo; pick the fixture before the
    // description is filed so the worker's stub call returns task guidance.
    await setAnalyzerFixture("multi");

    // --- Describe instead ---------------------------------------------------
    await page.locator("#describe-instead").click();
    await expect(page).toHaveURL(/\/check\/describe$/);
    const field = page.locator("#describe-text");
    const cont = page.locator("#describe-continue");
    await expect(field).toBeVisible();
    await expect(cont).toBeDisabled();

    await field.fill(SHORT_TEXT);
    await expect(cont).toBeDisabled();

    await field.fill(DESCRIPTION);
    await expect(cont).toBeEnabled();

    // Unsaved changes are protected by an opaque modal that does not visually
    // merge with the editor underneath it.
    await page.locator("#describe-dismiss").click();
    const discardDialog = page.locator("#describe-exit-modal");
    await expect(discardDialog).toBeVisible();
    await expect(discardDialog).toHaveAttribute(
      "aria-labelledby",
      "describe-modal-title",
    );
    await expect(discardDialog.locator(".describe-modal__card")).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await discardDialog.locator(".describe-modal__secondary").click();
    await expect(discardDialog).not.toBeVisible();
    await expect(field).toHaveValue(DESCRIPTION);

    await cont.click();

    // --- Back on the capture screen ----------------------------------------
    await expect(page).toHaveURL(/\/check$/);
    const tile = page.locator(".shot--description");
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(DESCRIPTION);
    await expect(tile.locator("[data-edit-description]")).toBeVisible();
    await expect(tile.locator("[data-remove-description]")).toBeVisible();
    await expect(page.locator("#describe-instead")).toBeVisible();

    // One description satisfies the rule with zero photos.
    await expect(page.locator(".shot img")).toHaveCount(0);
    await expect(progress).toContainText("0 of 3 photos taken");
    await expect(progress).toContainText("Try to take at least 3-5 photos");
    await expect(progress).not.toContainText("Description saved");
    await expect(progress).not.toContainText("Ready to finish");
    await expect(done).toBeEnabled();

    // --- Finish check → home ----------------------------------------------
    await finishCheck(page);

    // The text analysis produced guidance: at least one NEW card for the
    // multi fixture's conditions. Dismiss every generated card.
    const cardCount = await dismissAllNewResults(page);
    expect(cardCount).toBeGreaterThan(0);
  });
});
