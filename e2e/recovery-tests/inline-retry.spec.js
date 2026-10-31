import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";

test("inline retries expose progress, reject repeated activation, and restore after failure", async ({
  page,
}) => {
  await page.route("**/__inline_retry", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><head><title>Retry progress</title></head><body><main id="host"></main></body></html>',
    }),
  );
  await page.goto("/__inline_retry");
  await page.evaluate(async () => {
    const path = "/src/components/error-notice.js";
    const { showInlineError } = await import(path);
    const state = /** @type {any} */ (window);
    state.retryCalls = 0;
    showInlineError("Synthetic failure", {
      target: document.querySelector("#host"),
      retry: () => {
        state.retryCalls++;
        return new Promise((_, reject) => {
          state.rejectRetry = reject;
        });
      },
    });
  });
  const button = page.locator("#host button");
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText(t("common.retrying"));
  await expect(button).toHaveAttribute("aria-busy", "true");
  await button.evaluate((node) =>
    /** @type {HTMLButtonElement} */ (node).click(),
  );
  expect(
    await page.evaluate(() => /** @type {any} */ (window).retryCalls),
  ).toBe(1);
  await page.evaluate(() =>
    /** @type {any} */ (window).rejectRetry(new Error("synthetic failure")),
  );
  await expect(button).toBeEnabled();
  await expect(button).toHaveText(t("common.retry"));
  await expect(button).not.toHaveAttribute("aria-busy");
});
