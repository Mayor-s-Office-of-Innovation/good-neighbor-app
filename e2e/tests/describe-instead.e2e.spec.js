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
const RECOMMENDED_PHOTOS = 3;

test.describe("describe instead", () => {
  test("one description completes a check with zero photos and yields task cards", async ({
    page,
  }) => {
    await startCheck(page);
    const captureWidth = await page
      .locator(".check-timeline")
      .evaluate((element) => element.getBoundingClientRect().width);
    const done = page.locator("#done-check");
    const progress = page.locator("#check-progress");
    const finishPosition = await page
      .locator(".check-timeline")
      .evaluate((element) => {
        const button = element.querySelector("#done-check");
        const footer = element.querySelector("#check-footer");
        if (!button) {
          throw new Error("Finish check button not found");
        }
        if (!footer) {
          throw new Error("Finish check footer not found");
        }
        const buttonRect = button.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        return {
          bottomGap: element.getBoundingClientRect().bottom - buttonRect.bottom,
          centerDelta:
            footerRect.left +
            footerRect.width / 2 -
            (buttonRect.left + buttonRect.width / 2),
        };
      });
    expect(finishPosition.bottomGap).toBeCloseTo(32, 0);
    expect(finishPosition.centerDelta).toBeCloseTo(0, 0);

    // Zero photos, no description: the rule is not met.
    await expect(page.locator(".shot img")).toHaveCount(0);
    await expect(done).toBeDisabled();

    // The text artifact is analyzed like a photo; pick the fixture before the
    // description is filed so the worker's stub call returns task guidance.
    await setAnalyzerFixture("multi");

    // --- Describe instead ---------------------------------------------------
    await page.locator("#describe-instead").click();
    await expect(page).toHaveURL(/\/check\/describe$/);
    await expect(page.locator(".describe__main")).toHaveCSS(
      "justify-content",
      "flex-start",
    );
    const contentBottomGap = await page
      .locator(".describe__main")
      .evaluate((element) => {
        const card = element.querySelector(".describe__card");
        if (!card) throw new Error("Card not found");
        return (
          element.getBoundingClientRect().bottom -
          card.getBoundingClientRect().bottom
        );
      });
    expect(contentBottomGap).toBeLessThan(1);
    await expect
      .poll(() =>
        page
          .locator(".view-describe")
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBe(captureWidth);
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
    await expect(progress).toContainText(
      `0 of ${RECOMMENDED_PHOTOS} recommended photos taken`,
    );
    await expect(progress).toContainText(
      "We recommend taking at least 3 photos in a perimeter check.",
    );
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

  test("single-issue capture and description share the flow width and 20-character minimum", async ({
    page,
  }) => {
    await page.locator("#report-problem").click();
    await expect(page).toHaveURL(/\/problem$/);
    const capture = page.locator(".single-issue");
    const captureWidth = await capture.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    const donePosition = await capture.evaluate((element) => {
      const button = element.querySelector("#submit-report");
      const footer = element.querySelector(".check-timeline__footer");
      if (!button) {
        throw new Error("Done button not found");
      }
      if (!footer) {
        throw new Error("Done button footer not found");
      }
      const buttonRect = button.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      return {
        bottomGap: element.getBoundingClientRect().bottom - buttonRect.bottom,
        centerDelta:
          footerRect.left +
          footerRect.width / 2 -
          (buttonRect.left + buttonRect.width / 2),
      };
    });
    expect(donePosition.bottomGap).toBeCloseTo(32, 0);
    expect(donePosition.centerDelta).toBeCloseTo(0, 0);
    await expect(page.locator("#submit-report")).toBeDisabled();
    await expect(page.locator("#describe-instead")).toHaveClass(/btn-outline/);
    await expect(page.locator("#submit-report")).toHaveClass(
      /check-timeline__done/,
    );

    await page.locator("#describe-instead").click();
    await expect(page).toHaveURL(/\/problem\/describe$/);
    await expect(page.locator(".describe__subtitle")).toHaveText(
      "Describe the issue you see in as much detail as possible",
    );
    const subtitleMetrics = await page
      .locator(".describe__subtitle")
      .evaluate((element) => {
        const view = element.ownerDocument.defaultView;
        if (!view) throw new Error("Browser window not found");
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(
            view.getComputedStyle(element).lineHeight,
          ),
        };
      });
    expect(subtitleMetrics.height).toBeLessThanOrEqual(
      subtitleMetrics.lineHeight * 1.1,
    );
    await expect(page.locator("#describe-hint")).toHaveText(
      "At least 20 characters",
    );
    await expect
      .poll(() =>
        page
          .locator(".view-describe")
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBe(captureWidth);

    const field = page.locator("#describe-text");
    const cont = page.locator("#describe-continue");
    await field.fill("1234567890123456789");
    await expect(cont).toBeDisabled();
    await field.fill("12345678901234567890");
    await expect(cont).toBeEnabled();
    await cont.click();
    await expect(page).toHaveURL(/\/problem$/);
    await expect(page.locator("#submit-report")).toBeEnabled();
  });
});
