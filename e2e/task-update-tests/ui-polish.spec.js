import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { complaints: [] } }),
  );
  await page.route("**/__ui_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>UI layout test</title></head><body><main></main><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__ui_test");
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/main.js");
  });
});

test("home controls fit a narrow viewport and language choices fill their dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const { homeShell, heroBlock, emptyResults, taskTabs } = await load(
      "/src/components/today-view.templates.js",
    );
    await load("/src/components/site-switcher.js");
    /** @type {any} */ (document.querySelector("main")).innerHTML = homeShell({
      settingsMenuOpen: false,
      adminAccess: true,
      hero: heroBlock({
        siteName: "Synthetic site",
        summary: "",
        checkLabel: "Check",
      }),
      results:
        taskTabs({ activeId: "in_progress" }) +
        emptyResults({ homeFilter: "in_progress" }),
      showAnalysisDialogs: false,
      logoutError: "",
      logoutPending: false,
    });
    const switcher = /** @type {any} */ (
      document.querySelector("site-switcher")
    );
    switcher.providerName =
      "Synthetic provider with a deliberately long name to exercise truncation";
    switcher.render();
  });
  const row = await page.evaluate(() => {
    const gear = /** @type {any} */ (
      document.querySelector("#home-settings")
    ).getBoundingClientRect();
    const trigger = /** @type {any} */ (
      document.querySelector("#site-switcher-trigger")
    ).getBoundingClientRect();
    const label = /** @type {any} */ (
      document.querySelector("#site-switcher-trigger span")
    );
    return {
      sameRow: Math.abs(gear.y - trigger.y) < 2,
      fits: trigger.right <= gear.left,
      truncates: label.scrollWidth > label.clientWidth,
      aligned: window.getComputedStyle(
        /** @type {any} */ (document.querySelector(".home-results__empty")),
      ).textAlign,
    };
  });
  expect(row).toEqual({
    sameRow: true,
    fits: true,
    truncates: true,
    aligned: "center",
  });
  await page.evaluate(() =>
    /** @type {any} */ (document.querySelector("#language-dialog")).showModal(),
  );
  const choices = page.locator(".language-list__option");
  await expect(choices).toHaveCount(5);
  for (const width of [320, 868]) {
    await page.setViewportSize({ width, height: 1000 });
    const modal = await page.locator("#language-dialog").boundingBox();
    const option = await choices.first().boundingBox();
    const close = await page.locator(".language-dialog__close").boundingBox();
    if (!modal || !option || !close)
      throw new Error("Missing language controls");
    expect(Math.abs(option.x - modal.x - 24)).toBeLessThan(2);
    expect(
      Math.abs(modal.x + modal.width - option.x - option.width - 24),
    ).toBeLessThan(2);
    expect(
      Math.abs(modal.x + modal.width - close.x - close.width - 24),
    ).toBeLessThan(2);
    await expect(choices.first()).toHaveCSS("text-align", "center");
  }
  await page.screenshot({
    path: "/tmp/ui-language-fixed.png",
    animations: "disabled",
  });
  await page.locator(".language-dialog__close").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#language-dialog")).not.toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/ui-home-narrow.png",
  });
});

test("complaint splash has a viewport divider and composer has a back caret", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    window.history.replaceState({}, "", "/complaints");
    await load("/src/components/complaint-view.js");
    /** @type {any} */ (document.querySelector("main")).append(
      document.createElement("complaint-view"),
    );
  });
  await expect(page.locator("#log-complaint")).toBeVisible();
  await expect(page.locator(".care-header__nav wa-icon")).toHaveAttribute(
    "name",
    "xmark",
  );
  const divider = await page.locator(".splash-rule").boundingBox();
  if (!divider) throw new Error("Missing splash divider");
  expect(Math.abs(divider.x)).toBeLessThan(2);
  expect(divider.width).toBe(page.viewportSize()?.width);
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/ui-complaint-splash.png",
  });
  expect(
    (await new AxeBuilder({ page }).include("complaint-view").analyze())
      .violations,
  ).toEqual([]);
  await page.evaluate(() => {
    window.history.replaceState({}, "", "/complaints/new");
    /** @type {any} */ (document.querySelector("complaint-view")).remove();
    /** @type {any} */ (document.querySelector("main")).append(
      document.createElement("complaint-view"),
    );
  });
  await expect(page.locator("#close-complaint wa-icon")).toHaveAttribute(
    "name",
    "chevron-left",
  );
});

test("timeline header stays visible while scrolling and shares its row with close", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/task-update-dialog.js");
    const { taskUpdateDialogShell, taskUpdateTimeline } = await load(
      "/src/components/task-update-dialog.templates.js",
    );
    const task = {
      taskId: "synthetic",
      status: "in_progress",
      userFriendlyLabel: "Synthetic issue",
      description: "Synthetic description",
      address: "Synthetic site",
    };
    /** @type {any} */ (document.querySelector("main")).innerHTML =
      taskUpdateDialogShell({
        mode: "timeline",
        state: "ready",
        content: taskUpdateTimeline({
          task,
          updates: [],
          issueOrigin: "perimeter",
          originalMediaUrl: "/icons/camera.svg",
          mediaUrls: new Map(),
        }),
      });
    const filler = document.createElement("div");
    filler.style.height = "1500px";
    /** @type {any} */ (document.querySelector(".task-update__sheet")).append(
      filler,
    );
    /** @type {any} */ (
      document.querySelector("dialog.task-update")
    ).showModal();
  });
  const photo = await page.locator(".task-update__photo-trigger").boundingBox();
  const description = await page
    .locator(".task-update__description")
    .boundingBox();
  if (!photo || !description) throw new Error("Missing timeline evidence");
  expect(photo.y - description.y - description.height).toBeLessThanOrEqual(16);
  expect(photo.height).toBeLessThanOrEqual(122);
  await page.screenshot({
    path: "/tmp/ui-timeline-evidence.png",
    animations: "disabled",
  });
  const before = await page.locator(".task-update__header").boundingBox();
  await page.locator("dialog.task-update").evaluate((dialog) => {
    dialog.scrollTop = 300;
  });
  const after = await page.locator(".task-update__header").boundingBox();
  if (!before || !after) throw new Error("Missing timeline header");
  expect(Math.abs(before.y - after.y)).toBeLessThan(2);
  const close = await page.locator("[data-close]").boundingBox();
  const ticker = await page.locator(".status-ticker").boundingBox();
  if (!close || !ticker) throw new Error("Missing timeline controls");
  expect(close.x).toBeGreaterThan(ticker.x + ticker.width);
  expect(ticker.y).toBeGreaterThanOrEqual(close.y);
  expect(ticker.y + ticker.height).toBeLessThanOrEqual(close.y + close.height);
  await expect(page.locator("#task-update-title")).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/ui-timeline-sticky.png",
  });
  expect(
    (await new AxeBuilder({ page }).include("dialog.task-update").analyze())
      .violations,
  ).toEqual([]);
});

test("capture close is visible in dark mode and enabled finish uses primary colors", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/perimeter-check.js");
    const { shell, footer } = await load(
      "/src/components/perimeter-check.templates.js",
    );
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing test main");
    main.innerHTML = shell();
    const foot = document.querySelector("#check-footer");
    if (!foot) throw new Error("Missing capture footer");
    foot.innerHTML = footer({ items: [], analyzingOpen: true, complete: true });
    document.documentElement.classList.remove("wa-light");
    document.documentElement.classList.add("wa-dark");
  });
  await expect(page.locator("#cancel")).toBeVisible();
  const colors = await page.evaluate(() => {
    const icon = document.querySelector(".check-timeline__close-icon");
    const button = document.querySelector("#done-check");
    const close = document.querySelector("#cancel");
    if (!icon || !button || !close) throw new Error("Missing capture controls");
    return {
      icon: window.getComputedStyle(icon).backgroundColor,
      text: window.getComputedStyle(close).color,
      background: window.getComputedStyle(close).backgroundColor,
      primary: window.getComputedStyle(button).backgroundColor,
      ink: window.getComputedStyle(button).getPropertyValue("--ink").trim(),
    };
  });
  expect(colors.icon).toBe(colors.text);
  expect(colors.icon).not.toBe(colors.background);
  await expect(page.locator("#done-check")).toBeEnabled();
  expect(colors.primary).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: "/tmp/ui-capture-dark.png",
    animations: "disabled",
  });
  expect(
    (
      await new AxeBuilder({ page })
        .include(".check-timeline__topbar")
        .include("#check-footer")
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("Reports closes at the right edge and resolved green follows the theme", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/reports-view.js");
    const { reportsShell } = await load(
      "/src/components/reports-view.templates.js",
    );
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing test main");
    main.innerHTML = reportsShell({
      heading: "Reports",
      tab: "checks",
      body: '<span class="status-ticker status-ticker--success">Resolved</span>',
    });
  });
  for (const width of [320, 868]) {
    await page.setViewportSize({ width, height: 800 });
    const header = await page.locator(".reports__top").boundingBox();
    const close = await page.locator("#reports-home").boundingBox();
    if (!header || !close) throw new Error("Missing Reports header");
    expect(header.x + header.width - close.x - close.width).toBeLessThanOrEqual(
      5,
    );
  }
  for (const [theme, color] of [
    ["wa-light", "rgb(2, 94, 0)"],
    ["wa-dark", "rgb(4, 199, 0)"],
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.remove("wa-light", "wa-dark");
      document.documentElement.classList.add(theme);
    }, theme);
    await expect(page.locator(".status-ticker--success")).toHaveCSS(
      "color",
      color,
    );
  }
  await page.screenshot({
    path: "/tmp/ui-reports-close-fixed.png",
    animations: "disabled",
  });
});
