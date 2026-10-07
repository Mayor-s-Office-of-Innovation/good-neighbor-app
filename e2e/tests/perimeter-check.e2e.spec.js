// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t, tPattern } from "../helpers/i18n.js";
import {
  addPhoto,
  dismissAllNewResults,
  finishCheck,
  startCheck,
} from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";
import { PHOTO_ISSUES, PHOTO_CLEAR } from "../helpers/fixtures.js";

/*
  Perimeter check, end to end, against the local harness with the analyzer
  stub. One issue photo into the flat photo roll, plus the post-check cleanup
  pass:

  - input-1.jpg → stub returns the multi-concern fixture → task / condition
    cards for temporary shelters / litter / graffiti appear in the
    "Analyzing evidence" tray on the capture view.
  - The first live photo satisfies the completion rule in
    frontend/src/domain/check-completion.js; a description is the alternative
    covered by describe-instead.e2e.spec.js.
  - Finish check → back home, NEW task cards appear in the results tray →
    dismiss every generated card via its delete (trash) button + confirm.

  Every upload flows device→S3 (MinIO) via presigned PUT, registers the
  artifact, enqueues SQS, and the local worker pumps it to the stub, mirroring
  prod.
*/

const MIN_PHOTOS = 1;
const RECOMMENDED_PHOTOS = 3;

test.describe("perimeter check", () => {
  test("an all-clear check remains visible on home after finishing", async ({
    page,
  }) => {
    await startCheck(page);
    await setAnalyzerFixture("excellent");
    for (let count = 1; count <= MIN_PHOTOS; count += 1) {
      await addPhoto(page, PHOTO_CLEAR);
      await expect(page.locator(".shot img")).toHaveCount(count, {
        timeout: 30_000,
      });
    }

    await expect(page.locator("#done-check")).toBeEnabled();
    await finishCheck(page);

    const newClearCard = page.locator(
      ".home-results .analysis-tray--new .analysis-card--clear",
    );
    await expect(newClearCard).toHaveCount(1, { timeout: 90_000 });
    await expect(newClearCard).toContainText(t("card.clear.title"));
    await expect(page.locator(".analysis-tray--new")).toContainText(
      tPattern("analysis.checkTitle.today"),
    );

    await page.reload();
    await expect(newClearCard).toHaveCount(1, { timeout: 90_000 });
  });

  test("issue photo generates task guidance; Finish unlocks at one photo", async ({
    page,
  }) => {
    await startCheck(page);
    const progress = page.locator("#check-progress");
    const photoCount = progress.locator("strong");
    const done = page.locator("#done-check");
    const shots = page.locator(".shot img");
    const analyzingTray = page.locator(
      `section[aria-label="${t("check.analyzing.aria")}"]`,
    );

    await expect(photoCount).toHaveText(
      t("check.progress.count", { photos: 0, recommended: RECOMMENDED_PHOTOS }),
    );
    await expect(done).toBeDisabled();

    // --- Photo 1: the issues scene ----------------------------------------
    await setAnalyzerFixture("multi");
    await addPhoto(page, PHOTO_ISSUES);

    // Upload leg: the photo tile lands in the roll.
    await expect(shots).toHaveCount(1, { timeout: 30_000 });
    await expect(photoCount).toHaveText(
      t("check.progress.count", { photos: 1, recommended: RECOMMENDED_PHOTOS }),
    );
    await expect(progress).not.toContainText("Ready to finish");
    await expect(done).toBeEnabled();

    // Analyzer + guidance legs: the multi fixture's three conditions resolve
    // into completed cards in the analyzing tray (tents → immediate 311
    // escalation task; litter + graffiti → rules that may need an answer).
    // The stub answers fast, but the pipeline (SQS → worker → analyzer →
    // assessments:evaluate) takes a beat. A completed issue card proves the
    // issues analysis actually landed.
    const issueCards = analyzingTray.locator(".analysis-card--done");
    await expect(issueCards.first()).toBeVisible({ timeout: 90_000 });
    expect(await issueCards.count()).toBeGreaterThan(0);
    await expect(analyzingTray.locator(".analysis-card--clear")).toHaveCount(0);

    // The first photo satisfies the completion rule.
    await expect(photoCount).toHaveText(
      t("check.progress.count", {
        photos: MIN_PHOTOS,
        recommended: RECOMMENDED_PHOTOS,
      }),
    );

    // Wait for the photo's analysis to finish. An issue check must not add a
    // clear-check card alongside its issue cards.
    await expect(page.locator("#toggle-analyzing")).not.toContainText(
      t("card.pending.title"),
      { timeout: 90_000 },
    );
    await expect(analyzingTray.locator(".analysis-card--pending")).toHaveCount(
      0,
    );
    await expect(analyzingTray.locator(".analysis-card--failed")).toHaveCount(
      0,
    );
    await expect(analyzingTray.locator(".analysis-card--clear")).toHaveCount(0);
    await expect(issueCards.first()).toBeVisible();

    // The state update rebuilds the shared footer; focus must follow the
    // replacement toggle so keyboard users can reopen it immediately.
    const analysisToggle = page.locator("#toggle-analyzing");
    await analysisToggle.click();
    await expect(analysisToggle).toHaveAttribute("aria-expanded", "false");
    await expect(analysisToggle).toBeFocused();
    await expect(analyzingTray).toHaveCount(0);
    await analysisToggle.click();
    await expect(analysisToggle).toHaveAttribute("aria-expanded", "true");
    await expect(analysisToggle).toBeFocused();
    await expect(analyzingTray).toBeVisible();

    // --- Finish check → home ----------------------------------------------
    // No confirm dialog: the rule is met, so Finish goes straight home.
    await finishCheck(page);

    // The NEW results tray holds this check's fresh cards. The multi fixture
    // guarantees at least one NEW card for the issues photo. Dismiss every
    // generated card via its trash button.
    const cardCount = await dismissAllNewResults(page);
    expect(cardCount).toBeGreaterThan(0);
  });
});
