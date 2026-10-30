// @ts-check
import { test, expect } from "../helpers/harness.js";
import AxeBuilder from "@axe-core/playwright";
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

for (const route of ["/check", "/problem"]) {
  test(`${route}: camera and gallery markers clear on cancel and selection`, async ({
    page,
  }) => {
    await page.goto(route);
    for (const button of ["#add-photo", "[data-capture-upload]"]) {
      const chooserPromise = page.waitForEvent("filechooser");
      await page.locator(button).click();
      const chooser = await chooserPromise;
      expect(
        await page.evaluate(
          () =>
            JSON.parse(window.localStorage.getItem("gnp:camera-open") || "null")
              ?.route,
        ),
      ).toBe(route);
      await chooser.element().dispatchEvent("cancel");
      expect(
        await page.evaluate(() =>
          window.localStorage.getItem("gnp:camera-open"),
        ),
      ).toBeNull();
    }
    const chooserPromise = page.waitForEvent("filechooser");
    await page.locator("[data-capture-upload]").click();
    await (await chooserPromise).setFiles(PHOTO_CLEAR);
    await expect(page.locator(".shot")).toHaveCount(1);
    expect(
      await page.evaluate(() => window.localStorage.getItem("gnp:camera-open")),
    ).toBeNull();
  });

  test(`${route}: gallery handoff restores capture after a document restart`, async ({
    page,
  }) => {
    await page.goto(route);
    await expect(page.locator("#gallery-input")).toBeAttached();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.locator("[data-capture-upload]").click();
    await chooserPromise;
    // A full navigation destroys the document without the route-unmount cleanup.
    await page.goto("/today");
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.locator("#gallery-input")).toBeAttached();
    expect(
      await page.evaluate(() => window.localStorage.getItem("gnp:camera-open")),
    ).toBeNull();
  });

  test(`${route}: rejected gallery files show a themed, dismissible warning`, async ({
    page,
  }) => {
    await page.goto(route);
    await page.locator("#gallery-input").setInputFiles({
      name: "oversized-synthetic.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    const toast = page.locator(".app-toast--warning");
    await expect(toast).toBeVisible();
    const icon = toast.locator(".app-toast__icon");
    await expect(icon).toHaveAttribute("name", "triangle-exclamation");
    for (const theme of ["wa-light", "wa-dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.classList.remove("wa-light", "wa-dark");
        document.documentElement.classList.add(theme);
      }, theme);
      expect(
        await icon.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--wa-color-warning-on-quiet)";
          element.parentElement?.append(probe);
          const matches =
            window.getComputedStyle(element).color ===
            window.getComputedStyle(probe).color;
          probe.remove();
          return matches;
        }),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .include(".app-toast--warning")
        .withRules(["color-contrast", "button-name"])
        .analyze();
      expect(audit.violations).toEqual([]);
      await toast.screenshot({
        path: `/tmp/708-warning-${route.slice(1)}-${theme}.png`,
      });
    }
    await expect(page.locator(".shot")).toHaveCount(0);
    await toast.locator(".app-toast__close").focus();
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(0);
  });
}
