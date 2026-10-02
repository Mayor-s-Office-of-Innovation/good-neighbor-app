// @ts-check
import { test, expect } from "../helpers/harness.js";

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
  await page.getByRole("menuitem", { name: "Send feedback" }).click();

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

    const region = page.getByRole("region", { name: "Notifications" });
    const toast = region.locator(".app-toast");
    const status = toast.getByRole("status");
    const undo = toast.getByRole("button", { name: "Undo" });
    const close = toast.getByRole("button", {
      name: "Dismiss Issue deleted notification",
    });

    await expect(toast).toBeVisible();
    await expect(toast).toHaveClass(/app-toast--success/);
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(status).toContainText("Issue deleted");
    await expect(status).toContainText("Graffiti at 1660 Mission Street");
    await expect(undo).toBeFocused();
    await expect(close).toBeVisible();

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
        undoWidth: undoBox.width,
        undoHeight: undoBox.height,
        closeWidth: closeBox.width,
        closeHeight: closeBox.height,
      };
    });

    expect(metrics.top).toBe(0);
    expect(metrics.width).toBeLessThanOrEqual(430);
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
      hasText: "Ticket filing failed",
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

    await dialog.getByRole("button", { name: "Send" }).click();

    await expect(dialog).not.toBeVisible();
    const toast = page.locator(".app-toast--success");
    await expect(toast).toContainText("Feedback sent");
    await expect(toast).toContainText("Thanks for sharing!");
  });

  test("shows a failure toast and preserves feedback after a failed send", async ({
    page,
  }) => {
    await page.route("**/v1/feedback", async (route) => {
      await route.fulfill({ status: 503 });
    });
    const message = "Please keep this draft after failure.";
    const dialog = await prepareFeedback(page, message);

    await dialog.getByRole("button", { name: "Send" }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#feedback-text")).toHaveJSProperty(
      "value",
      message,
    );
    const toast = page.locator(".app-toast--error");
    await expect(toast).toContainText("Feedback failed to send");
    await expect(toast).toContainText("Please try again later.");
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
    await expect(toast).toContainText("You're offline");
    await expect(toast).toContainText(
      "Your photos are saved. We'll retry later.",
    );
    await toast
      .getByRole("button", { name: "Dismiss You're offline notification" })
      .click();
    await expect(toast).toHaveCount(0);
  });
});
