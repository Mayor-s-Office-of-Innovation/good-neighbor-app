import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [] } }),
  );
  await page.route("**/__prelaunch_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI regression checks</title></head><body><main id="fixture"></main><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__prelaunch_test");
  await page.evaluate(() => customElements.whenDefined("today-view"));
});

test("history focus follows the rounded outer corners after a dialog closes", async ({
  page,
}) => {
  await page.evaluate(() => {
    const host = document.querySelector("main");
    if (!host) throw new Error("Missing history host");
    host.innerHTML =
      '<section class="analysis-tray analysis-tray--history"><div class="history-card-list"><article class="analysis-card analysis-card--history"><button class="btn-card history-card__row">Synthetic history entry</button></article></div></section><dialog><button>Close</button></dialog>';
    const row = document.querySelector(".history-card__row");
    const dialog = document.querySelector("dialog");
    if (!row || !dialog) throw new Error("Missing history fixture");
    row.addEventListener("click", () => dialog.showModal());
    document
      .querySelector("dialog button")
      ?.addEventListener("click", () => dialog.close());
  });
  await page.locator(".history-card__row").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".history-card__row")).toBeFocused();
  const corners = await page.locator(".history-card__row").evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.borderTopLeftRadius, style.borderBottomRightRadius];
  });
  expect(corners).toEqual(["24px", "24px"]);
  await page.screenshot({ path: test.info().outputPath("history-focus.png") });
  await page.evaluate(() => document.documentElement.classList.add("wa-dark"));
  await page.screenshot({
    path: test.info().outputPath("history-focus-dark.png"),
  });
});

test("description has only Back and matching placeholder and input font sizes", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const path = "/src/components/describe-instead.templates.js";
    const css = "/src/components/describe-instead.css";
    const { shell } = await import(path);
    await import(css);
    const host = document.querySelector("main");
    if (!host) throw new Error("Missing description host");
    host.innerHTML = shell();
  });
  await expect(page.locator("#describe-dismiss")).toHaveCount(0);
  await expect(page.locator("#describe-close")).toBeVisible();
  const sizes = await page
    .locator("#describe-text")
    .evaluate((el) => [
      getComputedStyle(el).fontSize,
      getComputedStyle(el, "::placeholder").fontSize,
    ]);
  expect(sizes[0]).toBe(sizes[1]);
});

test("311 revalidation retains another card and toast dismissal does not reload lists", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/v1/tasks?**", (route) => {
    reads++;
    return route.fulfill({
      json: { tasks: [{ taskId: "other", status: "open" }] },
    });
  });
  const result = await page.evaluate(async () => {
    const dbPath = "/src/db.js";
    const { setSite } = await import(dbPath);
    await setSite("Synthetic site", {
      siteId: "synthetic-site",
      token: "mock-token",
    });
    const Base = /** @type {any} */ (customElements.get("today-view"));
    class FilingTest extends Base {
      connectedCallback() {}
      disconnectedCallback() {}
    }
    customElements.define(
      "filing-test",
      /** @type {CustomElementConstructor} */ (
        /** @type {unknown} */ (FilingTest)
      ),
    );
    const view = /** @type {any} */ (document.createElement("filing-test"));
    view._siteId = "synthetic-site";
    view._homeFilter = "todo";
    view._remainingStatus = "loaded";
    view._taskListFreshness.set("open", Date.now());
    view._render = (/** @type {any} */ model) =>
      `<div class="home"><section class="home-region--results">${model.tasks
        .filter((/** @type {any} */ task) => task.status === "open")
        .map(
          (/** @type {any} */ task) =>
            `<article class="analysis-card" data-task-id="${task.taskId}"><button>${task.taskId}</button></article>`,
        )
        .join("")}</section></div>`;
    view._watchDuplicates = () => {};
    view._hydrateVisibleHomeTasks = () => {};
    document.querySelector("main")?.append(view);
    view._renderHome({
      checks: [],
      tasks: [
        { taskId: "filed", status: "open" },
        { taskId: "other", status: "open" },
      ],
    });
    const other = view.querySelector('[data-task-id="other"]');
    view._applyTaskResult("filed", { taskId: "filed", status: "in_progress" });
    let reloads = 0;
    view.connectedCallback = () => {
      reloads++;
    };
    await view._refreshAfter311();
    const toastPath = "/src/state/toasts.js";
    const { show311FilingToast } = await import(toastPath);
    const toast = show311FilingToast({}, "Synthetic task");
    toast.close();
    return {
      sameCard: other === view.querySelector('[data-task-id="other"]'),
      filedGone: !view.querySelector('[data-task-id="filed"]'),
      reloads,
    };
  });
  expect(result).toEqual({ sameCard: true, filedGone: true, reloads: 0 });
  expect(reads).toBe(1);
});

test("complaint description preserves the composer and focuses without smooth scrolling", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const routePath = "/src/router.js";
    const viewPath = "/src/components/complaint-view.js";
    const { navigate } = await import(routePath);
    await import(viewPath);
    navigate("/complaints/new");
    document
      .querySelector("main")
      ?.append(document.createElement("complaint-view"));
    document
      .querySelector("#complaint-files")
      ?.setAttribute("data-preserved", "true");
  });
  await expect(page.locator("#describe-complaint")).toHaveClass(/btn-outline/);
  await page.locator("#describe-complaint").click();
  await expect(page.locator("#complaint-description")).toBeFocused();
  await expect(page.locator("#complaint-files")).toHaveAttribute(
    "data-preserved",
    "true",
  );
  await page
    .locator("#complaint-description")
    .fill("Synthetic complaint description");
  await expect(page.locator("#submit-complaint")).toBeEnabled();
});

test("lightbox failed image shows unavailable-image icon, text and a retry", async ({
  page,
}) => {
  await page.route("**/missing-test-photo", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.evaluate(async () => {
    const path = "/src/components/photo-lightbox.js";
    const { openPhotoLightbox } = await import(path);
    const host = document.querySelector("main");
    if (!host) throw new Error("Missing lightbox fixture");
    host.innerHTML =
      '<button data-photo-lightbox data-full-src="/missing-test-photo"><img src="/missing-test-photo" alt="Synthetic photo"></button>';
    await openPhotoLightbox(host, host.querySelector("button"));
  });
  await expect(page.locator(".photo-lightbox__recovery")).toBeVisible();
  await expect(
    page.locator('.photo-lightbox__recovery wa-icon[name="image-slash"]'),
  ).toBeVisible();
  await expect(page.locator(".photo-lightbox__recovery p")).toHaveText(
    t("lightbox.downloadFailed"),
  );
  await expect(page.locator("[data-photo-retry]")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include("photo-lightbox")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("lightbox-error.png") });
});
