// @ts-check
import { test, expect } from "../helpers/harness.js";
import { addPhoto, startCheck } from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";
import { PHOTO_ISSUES, PHOTO_CLEAR, PLACES } from "../helpers/fixtures.js";

/*
  Perimeter check, end to end, against the local harness with the analyzer
  stub. One spec, two photos, plus the post-check cleanup pass:

  - input-1.jpg (large) → stub returns multi-concern fixture → task cards for
    temporary shelters / litter / graffiti appear on the capture view.
  - input-2.jpg (small) → stub returns the clean fixture → no issue cards.
  - Finish check → back home, NEW task cards appear in the results tray →
    dismiss every generated card via its delete (trash) button + confirm.

  Both uploads flow device→S3 (MinIO) via presigned PUT, register the artifact,
  enqueue SQS, and the local worker pumps them to the stub, mirroring prod.
*/

test.describe("perimeter check", () => {
  test("issue photo generates task guidance; clean photo generates none", async ({
    page,
  }) => {
    await startCheck(page);

    // --- Photo 1: the issues scene, in place 1 ("15th St") -----------------
    await setAnalyzerFixture("multi");
    await addPhoto(page, PHOTO_ISSUES);

    // Upload leg: the photo tile lands in the timeline.
    const captured = page.locator(".perimeter-photo--captured img").first();
    await expect(captured).toBeVisible({ timeout: 30_000 });

    // Analyzer + guidance legs: condition labels appear on the place row and
    // task cards appear in the analysis tray. The stub answers fast, but the
    // pipeline (SQS → worker → analyzer → assessments:evaluate) takes a beat.
    const place1 = page.locator(".place-row", { hasText: PLACES[0] });
    await expect(
      place1.locator(".place-row__conditions li").first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(place1.locator(".place-row__conditions li")).toHaveCount(3);

    // --- Photo 2: clean scene, in place 2 ("Front entrance") ---------------
    await page
      .locator(".place-row__header")
      .filter({ hasText: PLACES[1] })
      .click();
    await setAnalyzerFixture("excellent");
    await addPhoto(page, PHOTO_CLEAR);
    const place2 = page.locator(".place-row", { hasText: PLACES[1] });
    await expect(
      place2.locator(".perimeter-photo--captured img").first(),
    ).toBeVisible({ timeout: 30_000 });

    // Clean verdict: the analyzed-with-zero-concerns terminal card ("No
    // issues found") renders in the tray once the pipeline lands for this
    // item. Waiting for THAT card (rather than asserting absence of
    // conditions) proves the analysis actually completed for photo 2 — a
    // failed or stalled analysis would never produce it.
    const newTray = page.locator('section[aria-label="Analyzing evidence"]');
    await expect(
      newTray
        .locator('.analysis-card[data-card-title="No issues found"]')
        .first(),
    ).toBeVisible({ timeout: 90_000 });

    // Both places reviewed; the footer reflects evidence rather than analysis
    // in progress.
    await expect(page.locator("#done-check")).toBeEnabled();

    // --- Finish check → home ----------------------------------------------
    // Place 3 ("Caledonia St") has no evidence, so Finish shows the "1 place
    // does not have a photo or description" confirm first; confirm it.
    await page.locator("#done-check").click();
    await expect(page.locator("#done-incomplete-dialog")).toBeVisible();
    await page.locator("#done-incomplete-finish").click();
    await expect(page.locator("#start-check")).toBeVisible({
      timeout: 30_000,
    });

    // The NEW results tray (aria-label "New analysis results") holds exactly
    // this check's fresh cards — GET /v1/tasks also returns older persisted
    // tasks from previous runs (DDB Local keeps state), which render in a
    // separate section. The tray can also re-render as evidence hydrates, so
    // wait for at least one card instead of reading the count once.
    const resultsTray = page.locator(
      'section[aria-label="New analysis results"]',
    );
    const newTrayCards = resultsTray.locator(".analysis-card");

    // The multi fixture's three conditions resolve into guidance: tents
    // (severity 3 → immediate 311 escalation task) and litter + graffiti
    // (severity 2 → rules that may need an answer before tasking). At least
    // one NEW card must appear for the issues photo; the clean photo adds none.
    await expect(newTrayCards.first()).toBeVisible({ timeout: 30_000 });
    const cardCount = await newTrayCards.count();
    expect(cardCount).toBeGreaterThan(0);

    // --- Dismiss every generated card via its trash button ----------------
    // Delete flow: trash (data-analysis-action="delete") → confirm dialog →
    // rejectAnalysisCondition → the card hides behind a 5s undo toast, and the
    // tray re-renders. Always drive the FIRST remaining card; when the last
    // card's deletion lands, the empty tray renders its "resolved or deleted"
    // placeholder, so expect the section to lose its cards.
    for (let remaining = cardCount; remaining > 0; remaining -= 1) {
      await newTrayCards
        .first()
        .locator('[data-analysis-action="delete"]')
        .click();
      await page.locator("#analysis-delete-confirm").click();
      await expect(newTrayCards).toHaveCount(remaining - 1, {
        timeout: 30_000,
      });
    }
    await expect(newTrayCards).toHaveCount(0);
  });
});
