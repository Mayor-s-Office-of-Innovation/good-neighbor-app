// @ts-check
import { test as base, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";
import { test } from "../helpers/harness.js";

/** Browser-side source for the exact Vite module instance loaded by the app. */
const loadActiveToastModule = `async () => {
  const moduleUrl = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .find((url) => new URL(url).pathname === "/src/state/toasts.js");
  if (!moduleUrl) throw new Error("Active toast module was not loaded");
  return import(moduleUrl);
}`;

/**
 * Open the feedback sheet from the settings menu and enter a message.
 * @param {import("@playwright/test").Page} page
 * @param {string} message
 */
async function prepareFeedback(page, message) {
  await page.locator("#home-settings").click();
  await page
    .getByRole("menuitem", { name: t("today.settings.feedback") })
    .click();

  const dialog = page.locator("#feedback-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#feedback-text").evaluate((element, value) => {
    /** @type {any} */ (element).value = value;
  }, message);
  return dialog;
}

test.describe("standardized app toasts", () => {
  test("renders the global toast contract and supports keyboard Undo", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.evaluate(async (moduleLoader) => {
      const { showToast } = await /** @type {any} */ (
        eval(`(${moduleLoader})`)
      )();
      /** @type {any} */ (window).__toastUndoCalled = false;
      showToast({
        title: "Issue deleted",
        message: "Graffiti at 1660 Mission Street",
        tone: "success",
        icon: "circle-check",
        duration: 0,
        focusAction: true,
        action: {
          label: "Undo",
          run: () => {
            /** @type {any} */ (window).__toastUndoCalled = true;
          },
        },
      });
    }, loadActiveToastModule);

    const region = page.getByRole("region", { name: t("toastUi.region.aria") });
    const toast = region.locator(".app-toast");
    const status = toast.getByRole("status");
    const undo = toast.getByRole("button", { name: "Undo" });
    const close = toast.getByRole("button", {
      // The title is this test's own fixture; the wrapper sentence is app copy.
      name: t("toastUi.dismiss.aria", { title: "Issue deleted" }),
    });

    await expect(toast).toBeVisible();
    await expect(toast).toHaveClass(/app-toast--success/);
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(status).toContainText("Issue deleted");
    await expect(status).toContainText("Graffiti at 1660 Mission Street");
    await expect(undo).toBeFocused();
    await expect(close).toBeVisible();

    // Some top-layer implementations intermittently resolve the popover host
    // to the viewport height. Its grid rows must still remain content-sized.
    await region.evaluate((element) => {
      element.style.blockSize = "100dvh";
    });

    const metrics = await toast.evaluate((element) => {
      const undoButton = element.querySelector(".app-toast__undo");
      const closeButton = element.querySelector(".app-toast__close");
      if (!undoButton) throw new Error("Undo missing");
      if (!closeButton) throw new Error("Close button missing");
      const toastBox = element.getBoundingClientRect();
      const undoBox = undoButton.getBoundingClientRect();
      const closeBox = closeButton.getBoundingClientRect();
      return {
        top: toastBox.top,
        width: toastBox.width,
        height: toastBox.height,
        undoWidth: undoBox.width,
        undoHeight: undoBox.height,
        closeWidth: closeBox.width,
        closeHeight: closeBox.height,
      };
    });

    expect(metrics.top).toBe(0);
    expect(metrics.width).toBeLessThanOrEqual(430);
    expect(metrics.height).toBeLessThan(200);
    expect(
      Math.max(metrics.undoWidth, metrics.undoHeight),
    ).toBeGreaterThanOrEqual(43);
    expect(metrics.closeWidth).toBeGreaterThanOrEqual(43);
    expect(metrics.closeHeight).toBeGreaterThanOrEqual(43);

    await undo.press("Enter");
    await expect(toast).toHaveCount(0);
    expect(
      await page.evaluate(() => /** @type {any} */ (window).__toastUndoCalled),
    ).toBe(true);
  });

  test("dismisses a standard toast after 3.5 seconds", async ({ page }) => {
    await page.evaluate(async (moduleLoader) => {
      const { show311ErrorToast } = await /** @type {any} */ (
        eval(`(${moduleLoader})`)
      )();
      show311ErrorToast();
    }, loadActiveToastModule);

    const toast = page.locator(".app-toast", {
      hasText: t("toast.ticketFailed.title"),
    });
    await expect(toast).toBeVisible();
    await page.waitForTimeout(3200);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 1000 });
  });

  test("shows a success toast after feedback is sent", async ({ page }) => {
    await page.route("**/v1/feedback", async (route) => {
      await route.fulfill({ status: 204 });
    });
    const dialog = await prepareFeedback(page, "The new toast looks good.");

    await dialog.getByRole("button", { name: t("feedback.send") }).click();

    await expect(dialog).not.toBeVisible();
    const toast = page.locator(".app-toast--success");
    await expect(toast).toContainText(t("toast.feedbackSuccess.title"));
    await expect(toast).toContainText(t("toast.feedbackSuccess.message"));
  });

  test("shows a failure toast and preserves feedback after a failed send", async ({
    page,
  }) => {
    await page.route("**/v1/feedback", async (route) => {
      await route.fulfill({ status: 503 });
    });
    const message = "Please keep this draft after failure.";
    const dialog = await prepareFeedback(page, message);

    await dialog.getByRole("button", { name: t("feedback.send") }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#feedback-text")).toHaveJSProperty(
      "value",
      message,
    );
    const toast = page.locator(".app-toast--error");
    await expect(toast).toContainText(t("toast.feedbackError.title"));
    await expect(toast).toContainText(t("toast.feedbackError.message"));
    await expect(page.locator("app-toasts")).toHaveAttribute(
      "popover",
      "manual",
    );
    expect(
      await page
        .locator("app-toasts")
        .evaluate((element) => element.matches(":popover-open")),
    ).toBe(true);
  });

  test("renders and dismisses an informational offline toast", async ({
    page,
  }) => {
    await page.evaluate(async (moduleLoader) => {
      const { showOfflinePhotosToast } = await /** @type {any} */ (
        eval(`(${moduleLoader})`)
      )();
      showOfflinePhotosToast();
    }, loadActiveToastModule);

    const toast = page.locator(".app-toast--info");
    await expect(toast).toContainText(t("toast.offlinePhotos.title"));
    await expect(toast).toContainText(t("toast.offlinePhotos.message"));
    await toast
      .getByRole("button", {
        name: t("toastUi.dismiss.aria", {
          title: t("toast.offlinePhotos.title"),
        }),
      })
      .click();
    await expect(toast).toHaveCount(0);
  });
});

base("renders notifications before a site has been bound", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("wa-otp-input#code-input")).toBeVisible();
  await expect(page.locator("app-toasts")).toHaveCount(1);

  await page.evaluate(async (moduleLoader) => {
    const { showOfflinePhotosToast } = await /** @type {any} */ (
      eval(`(${moduleLoader})`)
    )();
    showOfflinePhotosToast();
  }, loadActiveToastModule);

  await expect(page.locator(".app-toast--info")).toContainText(
    t("toast.offlinePhotos.message"),
  );
});
