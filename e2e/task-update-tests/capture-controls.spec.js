import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const photos = [
  "e2e/fixtures/photos/input-1.jpg",
  "e2e/fixtures/photos/input-2.jpg",
];

/** @param {import("@playwright/test").Page} page @param {string} name */
async function mount(page, name) {
  await page.route("**/v1/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/tasks/test-task/updates")
        ? {
            task: {
              taskId: "test-task",
              checkId: "test-check",
              canUploadPhotos: true,
              canUpdate: true,
            },
            updates: [],
          }
        : {},
    }),
  );
  await page.route("**/__capture_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Capture test</title></head><body><main><script type="module" src="/src/main.js"></script></main></body></html>',
    }),
  );
  await page.goto("/__capture_test");
  await page.evaluate(async (name) => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/main.js");
    const { setSite } = await load("/src/db.js");
    await setSite("Synthetic test site", {
      siteId: "test-site",
      token: "test-token",
    });
    if (name === "care-work-view")
      window.history.replaceState({}, "", "/care-work/new/power_washed");
    await load(`/src/components/${name}.js`);
    const host = /** @type {any} */ (document.createElement(name));
    document.querySelector("main")?.append(host);
    if (name === "task-update-dialog") {
      await host.open(
        {
          taskId: "test-task",
          checkId: "test-check",
          canUploadPhotos: true,
          canUpdate: true,
        },
        "notes",
      );
    }
  }, name);
  await expect(page.locator("[data-capture-camera]")).toBeVisible();
  if (name === "care-work-view") {
    // Async initialization schedules the route announcement for the next frame.
    // Wait for it before testing keyboard focus, or it can steal Enter from camera.
    await expect(page.locator("care-work-view h1")).toBeFocused();
  }
}

for (const name of [
  "perimeter-check",
  "problem-report",
  "care-work-view",
  "task-update-dialog",
]) {
  test(`${name}: camera and gallery append photos beneath accessible controls`, async ({
    page,
  }, info) => {
    await mount(page, name);
    await expect(page.locator(".capture-picker").first()).toBeHidden();
    const camera = page.locator("[data-capture-camera]");
    await camera.focus();
    const chooserPromise = page.waitForEvent("filechooser");
    await camera.press("Enter");
    const chooser = await chooserPromise;
    expect(await chooser.element().getAttribute("capture")).toBe("environment");
    await chooser.setFiles(photos[0]);
    const previews = page.locator(
      name === "care-work-view"
        ? ".care-thumbnails img"
        : name === "task-update-dialog"
          ? ".task-update__photo--draft"
          : ".shot__img",
    );
    await expect(previews).toHaveCount(1);
    const galleryPromise = page.waitForEvent("filechooser");
    await page.locator("[data-capture-upload]").click();
    const gallery = await galleryPromise;
    expect(await gallery.element().getAttribute("capture")).toBeNull();
    expect(gallery.isMultiple()).toBe(true);
    await gallery.setFiles(photos);
    await expect(previews).toHaveCount(3);
    for (const width of [390, 834]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const cluster = document
              .querySelector(".capture-controls")
              ?.getBoundingClientRect();
            const secondary = document
              .querySelector(".capture-controls__secondary button")
              ?.getBoundingClientRect();
            const preview = document
              .querySelector(
                ".shot__img, .care-thumbnails img, .task-update__photo--draft",
              )
              ?.getBoundingClientRect();
            return Boolean(
              cluster &&
                secondary &&
                preview &&
                Math.abs(secondary.x - cluster.x) < 2 &&
                preview.y >= cluster.bottom,
            );
          }),
        )
        .toBe(true);
      await page.screenshot({
        path: `/tmp/capture-${name}-${info.project.name}-${width}.png`,
      });
    }
    const accessibility = await new AxeBuilder({ page })
      .include(".capture-controls")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    if (name === "care-work-view") {
      await expect(page.locator("[data-capture-text]")).toHaveCount(0);
      await expect(page.locator("#care-note")).toBeVisible();
      return;
    }
    await page.locator("[data-capture-text]").click();
    if (name === "task-update-dialog")
      await expect(page.locator("[data-save-note]")).toBeVisible();
    else
      await expect(page).toHaveURL(
        new RegExp(
          name === "perimeter-check" ? "/check/describe" : "/problem/describe",
        ),
      );
  });
}
