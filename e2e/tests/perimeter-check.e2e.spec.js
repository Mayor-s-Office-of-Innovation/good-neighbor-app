// @ts-check
import { test, expect } from "../helpers/harness.js";
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
  stub. One spec, five photos into the flat photo roll, plus the post-check
  cleanup pass:

  - input-1.jpg → stub returns the multi-concern fixture → task / condition
    cards for temporary shelters / litter / graffiti appear in the
    "Analyzing evidence" tray on the capture view.
  - input-2.jpg × 4 → stub returns the clean fixture. Since photo 1 has issues,
    no clear-check card should appear. Finish stays disabled until the fifth
    photo lands (the completion rule in frontend/src/domain/check-completion.js:
    five photos, or one description — see describe-instead.e2e.spec.js).
  - Finish check → back home, NEW task cards appear in the results tray →
    dismiss every generated card via its delete (trash) button + confirm.

  Every upload flows device→S3 (MinIO) via presigned PUT, registers the
  artifact, enqueues SQS, and the local worker pumps it to the stub, mirroring
  prod.
*/

const MIN_PHOTOS = 5;

test.describe("perimeter check", () => {
  test("issue photo generates task guidance; Finish unlocks at five photos", async ({
    page,
  }) => {
    await startCheck(page);
    const progress = page.locator("#check-progress");
    const photoCount = progress.locator("strong");
    const done = page.locator("#done-check");
    const shots = page.locator(".shot img");
    const analyzingTray = page.locator(
      'section[aria-label="Analyzing evidence"]',
    );

    await expect(photoCount).toHaveText(`0 of ${MIN_PHOTOS} photos taken`);
    await expect(done).toBeDisabled();

    // --- Photo 1: the issues scene ----------------------------------------
    await setAnalyzerFixture("multi");
    await addPhoto(page, PHOTO_ISSUES);

    // Upload leg: the photo tile lands in the roll.
    await expect(shots).toHaveCount(1, { timeout: 30_000 });
    await expect(photoCount).toHaveText(`1 of ${MIN_PHOTOS} photos taken`);
    await expect(done).toBeDisabled();

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

    // --- Photos 2–5: the clean scene, four times ---------------------------
    // Photo 1's analysis has landed, so switching the fixture now cannot leak
    // into it. Reusing the same file is fine: each upload is its own artifact.
    await setAnalyzerFixture("excellent");
    for (let n = 2; n <= MIN_PHOTOS; n += 1) {
      await addPhoto(page, PHOTO_CLEAR);
      await expect(shots).toHaveCount(n, { timeout: 30_000 });
      if (n < MIN_PHOTOS) {
        await expect(photoCount).toHaveText(
          `${n} of ${MIN_PHOTOS} photos taken`,
        );
        await expect(done).toBeDisabled();
      }
    }

    // The fifth photo satisfies the completion rule: readiness appears
    // alongside the count and Finish enables.
    await expect(photoCount).toHaveText(
      `${MIN_PHOTOS} of ${MIN_PHOTOS} photos taken`,
    );
    await expect(progress).toContainText("Ready to finish.");
    await expect(done).toBeEnabled();

    // Wait for every photo's analysis to finish. A clear-check card is shown
    // only when the entire check has no issues, so these four clean photos
    // must not add one alongside photo 1's issue cards.
    await expect(page.locator("#toggle-analyzing")).not.toContainText(
      "Analyzing...",
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

    // --- Finish check → home ----------------------------------------------
    // No confirm dialog: the rule is met, so Finish goes straight home.
    await finishCheck(page);

    // The NEW results tray holds this check's fresh cards. The multi fixture
    // guarantees at least one NEW card for the issues photo; the clean photos
    // add none. Dismiss every generated card via its trash button.
    const cardCount = await dismissAllNewResults(page);
    expect(cardCount).toBeGreaterThan(0);
  });
});
