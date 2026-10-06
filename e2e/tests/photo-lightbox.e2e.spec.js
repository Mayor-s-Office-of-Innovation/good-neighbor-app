// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";
import { addPhoto, startCheck } from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

test.describe("photo lightbox", () => {
  test("opens the clicked photo when its thumbnail is replaced during lazy loading", async ({
    page,
  }) => {
    await startCheck(page);
    await setAnalyzerFixture("excellent");
    await addPhoto(page, PHOTO_CLEAR);
    const thumbnail = page.locator(".shot [data-photo-lightbox]");
    await expect(thumbnail).toBeVisible({ timeout: 30_000 });
    let release = () => {};
    /** @type {Promise<void>} */
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let requested = () => {};
    /** @type {Promise<void>} */
    const requestSeen = new Promise((resolve) => {
      requested = resolve;
    });
    await page.route("**/components/photo-lightbox.js", async (route) => {
      requested();
      await gate;
      await route.continue();
    });
    try {
      await thumbnail.click();
      await requestSeen;
      // Model an upload/poll render replacing the clicked node, not navigation.
      await thumbnail.evaluate((element) =>
        element.replaceWith(element.cloneNode(true)),
      );
    } finally {
      release();
    }
    await expect(
      page.getByRole("dialog", { name: t("lightbox.dialog.aria") }),
    ).toBeVisible();
  });

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

    const dialog = page.getByRole("dialog", {
      name: t("lightbox.dialog.aria"),
    });
    const close = page.getByRole("button", { name: t("lightbox.close.aria") });

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

    await thumbnail.click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/check$/);
    await expect(dialog).toBeHidden();
    await expect(thumbnail).toBeFocused();
  });
});
