import { test, expect } from "@playwright/test";

test("pull refresh is bounded, coalesced, and cancellable", async ({
  page,
}) => {
  await page.route("**/__refresh_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><main><section class="home-region--results"><div class="home-tabs" style="height:50px">Tabs</div><span data-task-refresh-status role="status"></span><button>Card action</button><article style="height:200px">Card</article></section></main></body></html>',
    }),
  );
  await page.goto("/__refresh_test");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/services/home-refresh.js";
    const { installHomeRefresh } = await import(modulePath);
    const host = document.querySelector("main");
    let calls = 0;
    let finish;
    const stop = installHomeRefresh(host, () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const card = host.querySelector("article");
    const gesture = (type, y, x = 30) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      });
      card.dispatchEvent(event);
    };
    gesture("touchstart", 100);
    gesture("touchmove", 130);
    gesture("touchend", 130);
    const short = calls;
    gesture("touchstart", 100);
    gesture("touchmove", 190, 200);
    gesture("touchend", 190);
    const sideways = calls;
    gesture("touchstart", 100);
    gesture("touchmove", 190);
    gesture("touchcancel", 190);
    gesture("touchend", 190);
    const cancelled = calls;
    gesture("touchstart", 100);
    gesture("touchmove", 190);
    gesture("touchend", 190);
    host.querySelector("button").click();
    const pending = {
      calls,
      busy: host.hasAttribute("data-home-refreshing"),
      status: host.querySelector('[role="status"]').textContent,
    };
    finish();
    await Promise.resolve();
    await Promise.resolve();
    stop();
    host.querySelector("button").click();
    const stopFailure = installHomeRefresh(host, async () => {
      throw new Error("Synthetic refresh failure");
    });
    gesture("touchstart", 100);
    gesture("touchmove", 190);
    gesture("touchend", 190);
    await Promise.resolve();
    await Promise.resolve();
    const failureOffset = host.style.getPropertyValue("--home-pull-offset");
    gesture("touchstart", 100);
    gesture("touchmove", 120);
    gesture("touchend", 120);
    const failureRetained =
      failureOffset !== "0px" &&
      host.style.getPropertyValue("--home-pull-offset") === failureOffset;
    stopFailure();
    return {
      failureRetained,
      short,
      sideways,
      cancelled,
      pending,
      finalCalls: calls,
      busy: host.hasAttribute("data-home-refreshing"),
    };
  });
  expect(result.failureRetained).toBe(true);
  expect(result.short).toBe(0);
  expect(result.sideways).toBe(0);
  expect(result.cancelled).toBe(0);
  expect(result.pending.calls).toBe(1);
  expect(result.pending.busy).toBe(true);
  expect(result.pending.status).toBe("");
  expect(result.finalCalls).toBe(1);
  expect(result.busy).toBe(false);
});

test("refresh controls are accessible and save errors span the viewport above a dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.route("**/__refresh_ui", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refresh test</title></head><body><main></main><dialog><form><input aria-label="Draft note" value="Keep this draft"></form></dialog><app-toasts></app-toasts></body></html>',
    }),
  );
  await page.goto("/__refresh_ui");
  await page.evaluate(async () => {
    for (const path of [
      "/src/styles/tokens.css",
      "/src/styles/base.css",
      "/src/components/today-view.css",
      "/src/components/app-toasts.js",
    ])
      await import(path);
    const path = "/src/components/today-view.templates.js";
    const { taskTabs } = await import(path);
    document.querySelector("main").innerHTML = taskTabs({ activeId: "todo" });
  });
  await expect(page.locator("[data-home-refresh]")).toHaveCount(0);
  const tab = page.locator('[data-home-filter="todo"]');
  await tab.focus();
  await expect(tab).toBeFocused();
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  expect(
    (await new AxeBuilder({ page }).include("main").analyze()).violations,
  ).toEqual([]);
  await page.evaluate(async () => {
    document.querySelector("dialog").showModal();
    const path = "/src/state/toasts.js";
    const { showTaskUpdateErrorToast } = await import(path);
    showTaskUpdateErrorToast(new Error("Synthetic save failure"), () => {});
  });
  const toast = page.locator(".app-toast--full-width");
  await expect(toast).toBeVisible();
  const bounds = await toast.boundingBox();
  expect(bounds.width).toBe(800);
  expect(bounds.x).toBe(0);
  await expect(page.locator("dialog input")).toHaveValue("Keep this draft");
  await page.screenshot({
    path: `e2e/test-results/refresh-${test.info().project.name}.png`,
  });
});

test("desktop mouse and wheel pulls refresh without hijacking controls, text or scrolling", async ({
  page,
}) => {
  await page.route("**/__desktop_refresh", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main><section class="home-region--results"><div class="home-tabs" style="height:50px">Tabs</div><span data-task-refresh-status></span><article style="height:1400px;padding:50px"><p>Selectable text remains selectable</p><button>Card action</button><div id="nested" style="height:60px;overflow:auto"><div style="height:300px">Nested scroll area</div></div></article></section></main></body></html>',
    }),
  );
  await page.goto("/__desktop_refresh");
  await page.evaluate(async () => {
    const path = "/src/services/home-refresh.js";
    const { installHomeRefresh } = await import(path);
    document.body.dataset.calls = "0";
    installHomeRefresh(document.querySelector("main"), async () => {
      document.body.dataset.calls = String(
        Number(document.body.dataset.calls) + 1,
      );
    });
  });
  // Drag blank card padding down, then release.
  await page.mouse.move(20, 100);
  await page.mouse.down();
  await page.mouse.move(20, 200, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("body")).toHaveAttribute("data-calls", "1");
  // A downward drag beginning on a button is not a pull.
  const button = await page.locator("article button").boundingBox();
  await page.mouse.move(button.x + 5, button.y + 5);
  await page.mouse.down();
  await page.mouse.move(button.x + 5, button.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("body")).toHaveAttribute("data-calls", "1");
  // Selecting text is allowed to keep the browser's native selection behavior.
  const paragraph = await page.locator("p").boundingBox();
  await page.mouse.move(paragraph.x + 2, paragraph.y + 8);
  await page.mouse.down();
  await page.mouse.move(paragraph.x + 80, paragraph.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("body")).toHaveAttribute("data-calls", "1");
  await page.evaluate(() => window.getSelection().removeAllRanges());
  // Ordinary upward scrolling and a nested scroll area never trigger refresh.
  await page.evaluate(() => {
    window.scrollTo(0, 100);
    document
      .querySelector("article")
      .dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, clientY: 300, deltaY: -150 }),
      );
    window.scrollTo(0, 0);
    document
      .querySelector("#nested")
      .dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, clientY: 230, deltaY: -150 }),
      );
  });
  await expect(page.locator("body")).toHaveAttribute("data-calls", "1");
  // At the page boundary, one wheel gesture produces one refresh despite inertia.
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++)
      document
        .querySelector("article")
        .dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, clientY: 300, deltaY: -40 }),
        );
  });
  await expect(page.locator("body")).toHaveAttribute("data-calls", "2");
});

test("pull reveals an indicator, refreshes on release and settles after completion", async ({
  page,
}) => {
  await page.route("**/__pull_motion", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pull refresh</title></head><body style="margin:0"><main><section class="home-region--results"><div class="home-results"></div></section></main></body></html>',
    }),
  );
  await page.goto("/__pull_motion");
  await page.evaluate(async () => {
    for (const path of [
      "/src/styles/tokens.css",
      "/src/styles/base.css",
      "/src/components/today-view.css",
      "/@id/@awesome.me/webawesome/dist/components/spinner/spinner.js",
      "/@id/@awesome.me/webawesome/dist/components/icon/icon.js",
    ])
      await import(path);
    const libraryPath =
      "/@id/@awesome.me/webawesome/dist/components/icon/library.js";
    const { registerIconLibrary } = await import(libraryPath);
    registerIconLibrary("default", {
      resolver: (name) => `/icons/${name}.svg`,
    });
    const templatePath = "/src/components/today-view.templates.js";
    const { taskTabs } = await import(templatePath);
    const markup =
      taskTabs({ activeId: "todo" }) +
      '<article id="list" style="height:800px;padding:30px;background:#eee">Synthetic task list</article>';
    document.querySelector(".home-results").innerHTML = markup;
    const servicePath = "/src/services/home-refresh.js";
    const { installHomeRefresh } = await import(servicePath);
    document.body.dataset.calls = "0";
    installHomeRefresh(document.querySelector("main"), () => {
      document.body.dataset.calls = String(
        Number(document.body.dataset.calls) + 1,
      );
      document.querySelector(".home-results").innerHTML =
        taskTabs({ activeId: "todo", refreshState: "refreshing" }) +
        '<article id="list" style="height:800px;padding:30px;background:#eee">Synthetic task list</article>';
      return new Promise((resolve) => {
        window.addEventListener(
          "finish-refresh",
          () => {
            document.querySelector(".home-results").innerHTML = markup;
            resolve(undefined);
          },
          { once: true },
        );
      });
    });
  });
  const list = page.locator("#list");
  const initial = await list.boundingBox();
  const tabs = await page.locator(".home-tabs").boundingBox();
  await page.mouse.move(10, initial.y + 50);
  await page.mouse.down();
  await page.mouse.move(10, initial.y + 150, { steps: 5 });
  await expect(page.locator("body")).toHaveAttribute("data-calls", "0");
  expect((await list.boundingBox()).y - initial.y).toBeCloseTo(65, 0);
  expect((await page.locator(".home-tabs").boundingBox()).y).toBe(tabs.y);
  await expect(page.locator(".home-pull-indicator")).toHaveCSS("opacity", "1");
  await page.mouse.up();
  await expect(page.locator("body")).toHaveAttribute("data-calls", "1");
  await expect(page.locator("main")).toHaveAttribute(
    "data-home-refreshing",
    "",
  );
  await expect(page.locator(".home-pull-spinner")).toBeVisible();
  await expect(page.locator(".home-pull-label")).toHaveText("Refreshing…");
  expect(
    (await page.locator(".home-pull-label").boundingBox()).y,
  ).toBeGreaterThan((await page.locator(".home-pull-spinner").boundingBox()).y);
  await expect(page.locator(".home-pull-spinner svg")).toHaveCSS(
    "animation-name",
    "spin",
  );
  expect((await page.locator(".home-pull-spinner").boundingBox()).width).toBe(
    24,
  );
  await expect
    .poll(() =>
      page
        .locator(".home-pull-spinner svg")
        .evaluate((node) => Number(node.getAnimations()[0]?.currentTime || 0)),
    )
    .toBeGreaterThan(300);
  await page.screenshot({
    path: `e2e/test-results/pull-loading-${test.info().project.name}.png`,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("finish-refresh")));
  await expect(page.locator("main")).not.toHaveAttribute(
    "data-home-refreshing",
    "",
  );
  await expect.poll(async () => (await list.boundingBox()).y).toBe(initial.y);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator(".home-pull-indicator")).toHaveCSS("opacity", "0");
  // A sub-threshold pull snaps back without another request.
  await page.mouse.move(10, initial.y + 50);
  await page.mouse.down();
  await page.mouse.move(10, initial.y + 80, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox()).y).toBe(initial.y);
  await expect(page.locator("body")).toHaveAttribute("data-calls", "1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await list.evaluate((node) =>
      parseFloat(getComputedStyle(node).transitionDuration),
    ),
  ).toBeLessThanOrEqual(0.00001);
});
