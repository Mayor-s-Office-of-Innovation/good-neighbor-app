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
  const expectFullBleedDivider = async () => {
    const divider = await page.locator(".splash-rule").boundingBox();
    const body = await page.locator("body").boundingBox();
    if (!divider || !body) throw new Error("Missing splash divider or body");
    // 100vw includes classic scrollbar space; the centered excess is clipped
    // by body. Check visible coverage, not an x=0 that only overlay bars give.
    expect(divider.width).toBe(page.viewportSize()?.width);
    expect(divider.x).toBeLessThanOrEqual(body.x + 1);
    expect(divider.x + divider.width).toBeGreaterThanOrEqual(
      body.x + body.width - 1,
    );
    expect(
      Math.abs(divider.x + divider.width / 2 - body.x - body.width / 2),
    ).toBeLessThan(2);
  };
  await expectFullBleedDivider();
  // Exercise reserved edge space even on macOS with overlay scrollbars.
  const gutter = await page.addStyleTag({
    content: "html { padding-inline-end: 15px; }",
  });
  await expectFullBleedDivider();
  await gutter.evaluate((element) => element.parentNode?.removeChild(element));
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

for (const leave of [false, true]) {
  test(`Reports waits for access with Close usable (leave=${leave})`, async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const load = (/** @type {string} */ path) => import(path);
      await load("/src/components/reports-view.js");
      const reports = /** @type {any} */ (
        document.createElement("reports-view")
      );
      reports._requireManager = () =>
        new Promise((resolve) => {
          /** @type {any} */ (window).resolveReportAccess = resolve;
        });
      reports._loadCatalog = async () => {};
      reports._mountSiteSwitcher = () => {};
      reports._loadReport = async () => {
        document.body.dataset.reportLoads = String(
          Number(document.body.dataset.reportLoads || 0) + 1,
        );
        reports._render();
      };
      document.querySelector("main")?.append(reports);
    });
    await expect(page.locator(".reports__head")).toHaveAttribute("inert", "");
    await expect(page.locator(".reports__body")).toHaveAttribute("inert", "");
    await page.locator('[data-report-tab="issues"]').dispatchEvent("click");
    await expect(page.locator("body")).not.toHaveAttribute("data-report-loads");
    await page.locator("#reports-home").focus();
    await expect(page.locator("#reports-home")).toBeFocused();
    if (leave) {
      await page.locator("#reports-home").click();
      await expect(page).toHaveURL(/\/today$/);
      await page
        .locator("reports-view")
        .evaluate((element) => element.remove());
    }
    await page.evaluate(() =>
      /** @type {any} */ (window).resolveReportAccess(true),
    );
    if (leave) {
      await expect(page.locator("body")).not.toHaveAttribute(
        "data-report-loads",
      );
    } else {
      await expect(page.locator("body")).toHaveAttribute(
        "data-report-loads",
        "1",
      );
      await expect(page.locator(".reports__head")).not.toHaveAttribute("inert");
      await page.locator('[data-report-tab="issues"]').click();
      await expect(page.locator("body")).toHaveAttribute(
        "data-report-loads",
        "2",
      );
    }
  });
}

test("lazy navigation blocks the retained screen and unlocks the new screen", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    const AppRoot = /** @type {any} */ (window.customElements.get("app-root"));
    window.history.replaceState({}, "", "/today");
    const root = new AppRoot();
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing main");
    main.innerHTML = '<button id="old-action">Old action</button>';
    root._view = main;
    root._restateScreenFocus = () => {};
    root._loadRoute(
      "/today",
      () =>
        new Promise((resolve) => {
          /** @type {any} */ (window).finishRouteImport = resolve;
        }),
    );
  });
  await expect(page.locator("#old-action")).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.locator("#old-action").evaluate((element) => element.focus());
  await expect(page.locator("#old-action")).not.toBeFocused();
  await page.evaluate(() => /** @type {any} */ (window).finishRouteImport());
  await expect(page.locator("main")).not.toHaveAttribute("inert");
  await expect(page.locator("#old-action")).toHaveCount(0);
  await expect(page.locator("today-view")).toHaveCount(1);
});

test("complaints keep the title and action visible when a long list scrolls", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    window.history.replaceState({}, "", "/complaints");
    await load("/src/components/complaint-view.js");
    document
      .querySelector("main")
      ?.append(document.createElement("complaint-view"));
  });
  await expect(page.locator("#log-complaint")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.remove("wa-light", "wa-dark");
      document.documentElement.classList.add(`wa-${theme}`);
    }, theme);
    const colors = await page
      .locator(".complaints__sticky")
      .evaluate((header) => ({
        header: window.getComputedStyle(header).backgroundColor,
        page: window.getComputedStyle(document.body).backgroundColor,
      }));
    expect(colors.header).toBe(colors.page);
  }
  await page.locator(".complaints__list").evaluate((list) => {
    list.innerHTML = Array.from(
      { length: 30 },
      (_, index) => `<p style="height:60px">Synthetic complaint ${index}</p>`,
    ).join("");
  });
  await page.evaluate(() => window.scrollTo(0, 700));
  const title = await page.locator(".care-header h1").boundingBox();
  const button = await page.locator("#log-complaint").boundingBox();
  const viewport = page.viewportSize();
  if (!title || !button || !viewport)
    throw new Error("Missing header geometry");
  expect(title.y).toBeGreaterThanOrEqual(0);
  expect(button.y).toBeGreaterThanOrEqual(0);
  expect(button.y + button.height).toBeLessThanOrEqual(viewport.height);
  await expect(page.locator(".care-header__nav")).toHaveCSS(
    "margin-bottom",
    "18px",
  );
  await page.screenshot({
    path: "/tmp/prelaunch-complaints-sticky.png",
    animations: "disabled",
  });
});

test("handoff has an app icon and enrollment errors stay centered without stale references", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const { handoffView } = await load("/src/components/app-root.templates.js");
    const { codeEntryView } = await load(
      "/src/components/site-setup.templates.js",
    );
    const { t } = await load("/src/i18n/i18n.js");
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing fixture main");
    main.innerHTML = handoffView() + `<site-setup></site-setup>`;
    const setup = /** @type {any} */ (document.querySelector("site-setup"));
    setup.innerHTML = codeEntryView({
      error: t("setup.enrollment.used"),
      reference: "synthetic-reference",
    });
    setup._otp = setup.querySelector("#code-input");
    setup._form = setup.querySelector("#code-form");
    setup._error = t("setup.enrollment.used");
    setup._enrollmentReference = "synthetic-reference";
    setup._otp.addEventListener("input", () => setup._onInput());
  });
  await expect(
    page.locator(".login__handoff").locator("..", {}).locator("img"),
  ).toHaveAttribute("src", "/img/icon-512.png");
  await expect(page.locator("#code-error")).toHaveCSS("text-align", "center");
  await page
    .locator("#code-input")
    .evaluate((otp) =>
      otp.dispatchEvent(new window.Event("input", { bubbles: true })),
    );
  await expect(page.locator("[data-support-reference]")).toHaveCount(0);
  await expect(page.locator("#code-error")).toBeHidden();
  await expect(page.locator("#code-input")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
});

test("care pending status stays on its row and distinguishes offline waiting", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/care-work-view.js");
    const { careList } = await load("/src/components/care-work.templates.js");
    const items = [
      {
        workId: "synthetic",
        kind: "power_washed",
        createdAt: "2026-10-16T12:00:00Z",
        status: "pending",
      },
    ];
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing fixture main");
    /** @type {any} */ (window).renderCare = (
      /** @type {boolean} */ offline,
    ) => {
      main.innerHTML = `<div class="care-work">${careList(items, false, offline)}</div>`;
    };
    /** @type {any} */ (window).renderCare(false);
  });
  await expect(page.locator(".care-row__status wa-spinner")).toBeVisible();
  const time = await page.locator(".care-row time").boundingBox();
  const status = await page.locator(".care-row__status").boundingBox();
  if (!time || !status) throw new Error("Missing care timestamp or status");
  expect(status.y).toBeGreaterThanOrEqual(time.y + time.height);
  expect(Math.abs(status.x + status.width - time.x - time.width)).toBeLessThan(
    2,
  );
  const saving = await page.evaluate(async () => {
    const path = "/src/i18n/i18n.js";
    return (await import(path)).t("care.savingShort");
  });
  await expect(page.locator(".care-row__status")).toHaveText(saving);
  expect(
    (await new AxeBuilder({ page }).include(".care-work").analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: "/tmp/prelaunch-care-row.png",
    animations: "disabled",
  });
  await page.evaluate(() => /** @type {any} */ (window).renderCare(true));
  await expect(page.locator(".care-row__status wa-spinner")).toHaveCount(0);
  const expected = await page.evaluate(async () => {
    const path = "/src/i18n/i18n.js";
    return (await import(path)).t("card.recovery.offline");
  });
  await expect(page.locator(".care-row__status")).toHaveText(expected);
});

test("oversized complaints header scrolls away and becomes sticky again when it fits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(async () => {
    window.history.replaceState({}, "", "/complaints");
    const path = "/src/components/complaint-view.js";
    await import(path);
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing fixture main");
    main.append(document.createElement("complaint-view"));
  });
  await expect(page.locator("#log-complaint")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
    const list = document.querySelector(".complaints__list");
    if (!list) throw new Error("Missing complaints list");
    list.innerHTML = Array.from(
      { length: 30 },
      (_, index) => `<p style="height:60px">Synthetic complaint ${index}</p>`,
    ).join("");
  });
  const header = page.locator(".complaints__sticky");
  await expect(header).toHaveCSS("position", "static");
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect
    .poll(async () => {
      const box = await header.boundingBox();
      if (!box) throw new Error("Missing complaints header");
      return box.y + box.height;
    })
    .toBeLessThan(0);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "16px";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(header).toHaveCSS("position", "sticky");
});

test("going offline preserves the care logs already displayed", async ({
  page,
  context,
}) => {
  await page.route("**/v1/care-work**", (route) =>
    route.fulfill({
      json: {
        work: [
          {
            workId: "synthetic-saved",
            kind: "power_washed",
            createdAt: "2026-10-27T12:00:00Z",
            photos: [],
          },
        ],
      },
    }),
  );
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const { setSite } = await load("/src/db.js");
    await setSite("Synthetic review site", { siteId: "review-only" });
    window.history.replaceState({}, "", "/care-work");
    await load("/src/components/care-work-view.js");
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing fixture main");
    main.append(document.createElement("care-work-view"));
  });
  await expect(page.locator('[data-work="synthetic-saved"]')).toBeVisible();
  await page.route("**/v1/care-work**", (route) => route.abort());
  // Observe the real offline handler's DOM update instead of calling it directly.
  await page.locator("care-work-view").evaluate((host) => {
    const observer = new window.MutationObserver(() => {
      observer.disconnect();
      host.setAttribute("data-offline-rendered", "true");
    });
    observer.observe(host, { childList: true });
  });
  await context.setOffline(true);
  await expect
    .poll(() => page.evaluate(() => window.navigator.onLine))
    .toBe(false);
  await expect(page.locator("care-work-view")).toHaveAttribute(
    "data-offline-rendered",
    "true",
  );
  await expect(page.locator('[data-work="synthetic-saved"]')).toBeVisible();
});

test("sticky complaints header reserves and paints the safe-area band", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    window.history.replaceState({}, "", "/complaints");
    const path = "/src/components/complaint-view.js";
    await import(path);
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing fixture main");
    main.append(document.createElement("complaint-view"));
  });
  await expect(page.locator("#log-complaint")).toBeVisible();
  await page.evaluate(() => {
    const header = document.querySelector(".complaints__sticky");
    const list = document.querySelector(".complaints__list");
    if (!(header instanceof window.HTMLElement) || !list)
      throw new Error("Missing complaints layout");
    // Device emulation doesn't supply a nonzero CSS safe-area inset.
    header.style.setProperty("--complaints-safe-top", "48px");
    list.innerHTML = Array.from(
      { length: 30 },
      (_, index) => `<p style="height:60px">Synthetic complaint ${index}</p>`,
    ).join("");
    window.dispatchEvent(new window.Event("resize"));
    window.scrollTo(0, 700);
  });
  const header = page.locator(".complaints__sticky");
  await expect(header).toHaveCSS("position", "sticky");
  await expect.poll(async () => (await header.boundingBox())?.y).toBe(48);
  const geometry = await header.evaluate((element) => {
    const band = window.getComputedStyle(element, "::before");
    const host = element.closest("complaint-view");
    if (!host) throw new Error("Missing complaints host");
    return {
      height: element.getBoundingClientRect().height,
      margin: parseFloat(
        window
          .getComputedStyle(host)
          .getPropertyValue("--complaints-header-height"),
      ),
      bandHeight: band.height,
      bandColor: band.backgroundColor,
      headerColor: window.getComputedStyle(element).backgroundColor,
    };
  });
  expect(geometry.bandHeight).toBe("48px");
  expect(geometry.bandColor).toBe(geometry.headerColor);
  expect(geometry.margin).toBeCloseTo(geometry.height + 48 + 16, 1);
  await page.setViewportSize({
    width: 390,
    height: Math.floor(geometry.height * 2 + 48) - 2,
  });
  await expect(header).toHaveCSS("position", "static");
  await expect
    .poll(() =>
      header.evaluate(
        (element) => window.getComputedStyle(element, "::before").display,
      ),
    )
    .toBe("none");
});
