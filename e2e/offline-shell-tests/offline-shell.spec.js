// @ts-check
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

/*
  Offline launch (offlineShell in frontend/vite.config.js), against a built
  preview: the app opens offline, API calls are never answered by the worker,
  and an online launch picks up a new release without a reload.
*/

const frontendDir = fileURLToPath(new URL("../../frontend", import.meta.url));

/** @param {import("@playwright/test").Page} page */
async function openControlled(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const { serviceWorker } = window.navigator;
    await serviceWorker.ready;
    while (!serviceWorker.controller)
      await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** @param {import("@playwright/test").Page} page */
function entryScript(page) {
  return page
    .locator('script[type="module"][src*="/assets/index-"]')
    .getAttribute("src");
}

test("opens, reloads, and follows deep links offline", async ({ page }) => {
  await openControlled(page);
  await page.context().setOffline(true);

  await page.reload();
  await expect(page.locator("app-root > *").first()).toBeAttached();

  await page.goto("/care-work");
  await expect(page.locator("app-root > *").first()).toBeAttached();
});

test("never answers API calls or file links with the app", async ({ page }) => {
  await openControlled(page);
  await page.context().setOffline(true);

  const health = await page.evaluate(() =>
    fetch("/health").then(
      (response) => response.headers.get("content-type"),
      () => "network error",
    ),
  );
  expect(health).toBe("network error");
  await expect(page.goto("/sample-compliance-letter.pdf")).rejects.toThrow();
});

test("an online launch opens a new release right away", async ({ page }) => {
  await openControlled(page);
  const before = await entryScript(page);

  execSync("npx vite build", {
    cwd: frontendDir,
    env: { ...process.env, RELEASE_SHA: `offline-shell-${Date.now()}` },
    stdio: "ignore",
  });

  const next = await page.context().newPage();
  let navigations = 0;
  next.on("framenavigated", (frame) => {
    if (frame === next.mainFrame()) navigations += 1;
  });
  await next.goto("/");
  const after = await entryScript(next);
  expect(after).not.toBe(before);
  expect(navigations).toBe(1);
});
