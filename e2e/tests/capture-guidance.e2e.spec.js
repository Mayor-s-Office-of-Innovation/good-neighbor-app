// @ts-check
import { test, expect } from "../helpers/harness.js";
import { addPhoto, startCheck } from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";
import { t } from "../helpers/i18n.js";

// History is deterministic per test; uploads and shot classification still
// traverse the real API, object store, worker and analyzer adapter.
for (const shotType of /** @type {const} */ (["detail", "wide"])) {
  test(`${shotType} framing prompts, acknowledgement, extra photos and deletion`, async ({
    page,
  }) => {
    await page.route("**/v1/checks:capture-guidance?*", (route) =>
      route.fulfill({ json: { counts: [2, 0, 0, 0, 0] } }),
    );
    await startCheck(page);
    const title = page.locator(".check-timeline__title");
    const count = page.locator("#check-progress");
    await expect(title).toHaveText(t("check.title.third"));
    await expect(count).toBeHidden();
    await expect(page.locator("#done-check")).toBeDisabled();

    for (let n = 1; n <= 4; n++) {
      await setAnalyzerFixture(
        "excellent",
        n === 3 ? (shotType === "detail" ? "wide" : "detail") : shotType,
      );
      await addPhoto(page, PHOTO_CLEAR);
      await expect(count).toHaveText(
        t(n === 1 ? "check.photos.one" : "check.photos.other", { photos: n }),
      );
      // Wait for this artifact's classified analysis before changing the stub.
      await expect(page.locator(".shot .capture-scanner")).toHaveCount(0, {
        timeout: 90_000,
      });
      await expect(title).toHaveText(
        t(
          n === 1
            ? "check.title.third"
            : n === 2
              ? shotType === "detail"
                ? "check.title.needWide"
                : "check.title.needDetail"
              : n === 3
                ? "check.title.greatShot"
                : "check.title.extra",
        ),
      );
      await expect(page.locator("#done-check")).toBeEnabled();
    }
    await page.locator(".shot [data-del]").first().click();
    await expect(count).toHaveText(t("check.photos.other", { photos: 3 }));
    await expect(title).toHaveText(t("check.title.greatShot"));
    await page.locator(".shot [data-del]").first().click();
    await expect(title).toHaveText(
      t(
        shotType === "detail"
          ? "check.title.needWide"
          : "check.title.needDetail",
      ),
    );
  });
}

for (const scenario of [
  { name: "first check", counts: [0, 0, 0, 0, 0], key: "check.title" },
  { name: "second check", counts: [1, 0, 0, 0, 0], key: "check.title" },
  { name: "fourth day", counts: [0, 3, 3, 3, 0], key: "check.title.fourDays" },
  { name: "fifth day", counts: [0, 3, 3, 3, 3], key: "check.title" },
  {
    name: "later check on fourth day",
    counts: [1, 3, 3, 3, 0],
    key: "check.title",
  },
]) {
  test(`${scenario.name}: starting title survives reload`, async ({ page }) => {
    let reads = 0;
    await page.route("**/v1/checks:capture-guidance?*", (route) => {
      reads++;
      return route.fulfill({ json: { counts: scenario.counts } });
    });
    await startCheck(page);
    await expect.poll(() => reads).toBe(1);
    await expect(page.locator(".check-timeline__title")).toHaveText(
      t(scenario.key),
    );
    await expect(page.locator("#check-progress")).toBeHidden();
    await page.reload();
    await expect(page.locator(".check-timeline__title")).toHaveText(
      t(scenario.key),
    );
    expect(reads).toBe(1);
  });
}

test("unavailable history and unclassified photos retain useful guidance; failed uploads do not count", async ({
  page,
}) => {
  await page.route("**/v1/checks:capture-guidance?*", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "capture_guidance_not_ready" } },
    }),
  );
  await startCheck(page);
  const title = page.locator(".check-timeline__title");
  const count = page.locator("#check-progress");
  await expect(title).toHaveText(t("check.title"));
  await page.route("**/artifacts:presign", (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: "invalid_request" } },
    }),
  );
  await addPhoto(page, PHOTO_CLEAR);
  await expect(page.locator(".shot")).toHaveCount(1);
  await expect(count).toBeHidden();
  await expect(title).toHaveText(t("check.title"));
  await page.unroute("**/artifacts:presign");
  await setAnalyzerFixture("excellent");
  for (let n = 1; n <= 4; n++) {
    await addPhoto(page, PHOTO_CLEAR);
    await expect(count).toHaveText(
      t(n === 1 ? "check.photos.one" : "check.photos.other", { photos: n }),
    );
    await expect(title).toHaveText(
      t(n === 4 ? "check.title.extra" : "check.title"),
    );
  }
});
