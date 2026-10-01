// @ts-check
import { test, expect } from "../helpers/harness.js";
import { addPhoto, startCheck } from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

test.describe("photo lightbox", () => {
  test("a capture thumbnail survives reload and supports every dismissal path", async ({
    page,
  }) => {
    await startCheck(page);
    await setAnalyzerFixture("excellent");
    await addPhoto(page, PHOTO_CLEAR);

    const thumbnail = page.locator(".shot [data-photo-lightbox]");
    await expect(thumbnail).toBeVisible({ timeout: 30_000 });

    // Regression: the thumbnail reset must be in the eager stylesheet. When it
    // lived with the lazy lightbox CSS, a reload exposed the global button
    // padding/background until the first time the viewer opened.
    await page.reload();
    await expect(thumbnail).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        thumbnail.evaluate((trigger) => {
          const image = trigger.querySelector("img");
          if (!image) return null;
          const view = trigger.ownerDocument.defaultView;
          if (!view) return null;
          const triggerStyle = view.getComputedStyle(trigger);
          const imageStyle = view.getComputedStyle(image);
          const triggerBox = trigger.getBoundingClientRect();
          const imageBox = image.getBoundingClientRect();
          return {
            padding: triggerStyle.padding,
            background: triggerStyle.backgroundColor,
            objectFit: imageStyle.objectFit,
            sameWidth: imageBox.width === triggerBox.width,
            sameHeight: imageBox.height === triggerBox.height,
          };
        }),
      )
      .toEqual({
        padding: "0px",
        background: "rgba(0, 0, 0, 0)",
        objectFit: "cover",
        sameWidth: true,
        sameHeight: true,
      });

    const dialog = page.getByRole("dialog", { name: "Photo viewer" });
    const close = page.getByRole("button", { name: "Close photo viewer" });

    await thumbnail.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".photo-lightbox__image")).toBeVisible();
    await expect(dialog.locator("figcaption")).toContainText(/ · /);
    await expect(close).toBeFocused();

    await close.click();
    await expect(dialog).toBeHidden();
    await expect(thumbnail).toBeFocused();

    await thumbnail.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(thumbnail).toBeFocused();

    await thumbnail.click();
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Photo lightbox has no bounding box");
    await page.mouse.click(Math.max(1, box.x - 8), box.y + box.height / 2);
    await expect(dialog).toBeHidden();
    await expect(thumbnail).toBeFocused();
  });
});
