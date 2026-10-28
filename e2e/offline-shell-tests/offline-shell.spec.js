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

test("leaves manager screens and other languages out of the precache", async ({
  page,
}) => {
  await openControlled(page);
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await window.caches.keys()) {
      if (!name.startsWith("workbox-precache")) continue;
      const cache = await window.caches.open(name);
      for (const request of await cache.keys())
        urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
  expect(cached.some((url) => url.includes("/care-work-view-"))).toBe(true);
  for (const chunk of ["site-admin", "reports-view", "es", "zh-Hant"])
    expect(cached.filter((url) => url.startsWith(`/assets/${chunk}-`))).toEqual(
      [],
    );
});

test("caches a language once it has loaded", async ({ page }) => {
  await openControlled(page);
  const entry = await entryScript(page);
  // The language catalogs are lazy chunks; their hashed URLs are listed in
  // the bundle's import map, which is what a language switch loads.
  const spanish = await page.evaluate(async (src) => {
    const chunks = await Promise.all(
      [
        src,
        ...[...document.querySelectorAll('link[rel="modulepreload"]')].map(
          (link) => link.getAttribute("href"),
        ),
      ]
        .filter(Boolean)
        .map((url) => fetch(/** @type {string} */ (url)).then((r) => r.text())),
    );
    const match = chunks.join("\n").match(/assets\/es-[\w-]+\.js/);
    if (!match) throw new Error("No Spanish chunk in the bundle");
    await fetch(`/${match[0]}`);
    return `/${match[0]}`;
  }, entry);

  await page.context().setOffline(true);
  const result = await page.evaluate(async (url) => {
    const saved = await (await window.caches.open("languages")).match(url);
    const response = await fetch(url);
    return { saved: Boolean(saved), status: response.status };
  }, spanish);
  expect(result).toEqual({ saved: true, status: 200 });
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
