// @ts-check
import { test, expect } from "../helpers/harness.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

for (const [route, tag, doneId] of [
  ["/problem", "problem-report", "submit-report"],
  ["/check", "perimeter-check", "done-check"],
]) {
  test(`${tag}: completion waits for the full gallery batch`, async ({
    page,
  }) => {
    await page.goto(route);
    await expect(page.locator("#gallery-input")).toBeAttached();
    await page.evaluate(() => {
      const original = window.FileReader.prototype.readAsDataURL;
      /** @type {(() => void)[]} */
      const reads = [];
      Object.assign(window, { captureReads: reads });
      window.FileReader.prototype.readAsDataURL = function (
        /** @type {Blob} */ file,
      ) {
        reads.push(() => original.call(this, file));
      };
    });
    const gallery = page.locator("#gallery-input");
    const done = page.locator(`#${doneId}`);
    await gallery.setInputFiles([PHOTO_CLEAR, PHOTO_CLEAR]);
    await expect(done).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(() => /** @type {any} */ (window).captureReads.length),
      )
      .toBe(1);
    await page.evaluate(() =>
      /** @type {any} */ (window).captureReads.shift()(),
    );
    await expect(page.locator(".shot")).toHaveCount(1);
    await expect(done).toBeDisabled();
    // A direct completion call must respect the same guard as the button.
    await page
      .locator(tag)
      .evaluate((element) => /** @type {any} */ (element)._done());
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    // Another selection must append without releasing the completion guard early.
    await gallery.setInputFiles(PHOTO_CLEAR);
    await expect
      .poll(() =>
        page.evaluate(() => /** @type {any} */ (window).captureReads.length),
      )
      .toBe(1);
    await page.evaluate(() =>
      /** @type {any} */ (window).captureReads.shift()(),
    );
    await expect(page.locator(".shot")).toHaveCount(2);
    await expect(done).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(() => /** @type {any} */ (window).captureReads.length),
      )
      .toBe(1);
    await page.evaluate(() =>
      /** @type {any} */ (window).captureReads.shift()(),
    );
    await expect(page.locator(".shot")).toHaveCount(3);
    await expect(done).toBeEnabled();
    await done.click();
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
  });
}
