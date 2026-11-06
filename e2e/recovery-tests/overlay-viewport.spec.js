import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

for (const viewport of [
  { width: 320, height: 568 },
  { width: 568, height: 320 },
]) {
  test(`menus and tall dialogs stay reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/__overlay_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Overlay checks</title><main></main></html>',
      }),
    );
    await page.goto("/__overlay_test");
    await page.evaluate(async () => {
      for (const path of [
        "/src/styles/tokens.css",
        "/src/styles/base.css",
        "/src/components/today-view.css",
        "/src/components/site-switcher.css",
      ])
        await import(path);
      const path = "/src/lib/menu-viewport.js";
      const { containMenus } = await import(path);
      const host = document.querySelector("main");
      if (!host) throw new Error("Missing fixture host");
      host.innerHTML =
        '<section class="home-region home-region--header" style="margin:40px 16px"><div class="home-actions" style="margin-top:180px"><button class="btn-blue" style="width:260px">Synthetic long label</button><div class="home-action-menu-wrap"><button id="home-action-menu-trigger" class="home-action-menu-trigger">...</button><div class="home-action-menu" hidden><button>First</button><button>Second</button><button id="last-menu-action">Last</button></div></div></div></section><dialog class="places-modal"><form class="places-modal__card"><h2>Synthetic dialog</h2><p style="height:800px;flex-shrink:0">Synthetic content</p><button id="last-dialog-action">Confirm</button></form></dialog>';
      const containment = containMenus(host);
      const trigger = document.querySelector("#home-action-menu-trigger");
      const menu = document.querySelector(".home-action-menu");
      if (
        !(trigger instanceof window.HTMLElement) ||
        !(menu instanceof window.HTMLElement)
      )
        throw new Error("Missing menu fixture");
      trigger.addEventListener("click", () => {
        menu.hidden = false;
        containment.update();
      });
    });
    await page.locator("#home-action-menu-trigger").click();
    await expect
      .poll(() =>
        page.locator(".home-action-menu").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.left >= 15 &&
            r.right <= window.innerWidth - 15 &&
            r.top >= 15 &&
            r.bottom <= window.innerHeight - 15
          );
        }),
      )
      .toBe(true);
    await page.locator("#last-menu-action").focus();
    await expect(page.locator("#last-menu-action")).toBeInViewport();
    await page.locator("dialog").evaluate((dialog) => {
      if (!(dialog instanceof window.HTMLDialogElement))
        throw new Error("Missing dialog fixture");
      dialog.showModal();
    });
    await page.locator("#last-dialog-action").focus();
    await expect(page.locator("#last-dialog-action")).toBeInViewport();
    expect(
      await page.locator("dialog").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.top >= 15 &&
          r.bottom <= window.innerHeight - 15 &&
          window.getComputedStyle(el).overflowY === "auto"
        );
      }),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog")).not.toBeVisible();
  });
}

test("settings and site menus fit long labels and resize while open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route("**/__menus_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Menu checks</title><body></body></html>',
    }),
  );
  await page.goto("/__menus_test");
  await page.evaluate(async () => {
    for (const path of [
      "/src/components/today-view.css",
      "/src/components/site-switcher.css",
    ])
      await import(path);
    const path = "/src/lib/menu-viewport.js";
    const { containMenus } = await import(path);
    document.body.innerHTML =
      '<main style="padding-top:240px"><div class="home-settings-wrap"><button id="home-settings">Settings</button><div class="home-settings-menu"><button>Synthetic very long translated settings label that must wrap</button><button id="settings-last">Last</button></div></div><div class="home-site-switcher"><button id="site-switcher-trigger">Sites</button><div class="home-site-switcher__menu">' +
      '<button class="home-site-switcher__item">Synthetic site name</button>'.repeat(
        20,
      ) +
      "</div></div></main>";
    containMenus(document.querySelector("main")).update();
  });
  for (const size of [
    { width: 320, height: 568 },
    { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(size);
    for (const selector of [
      ".home-settings-menu",
      ".home-site-switcher__menu",
    ]) {
      await expect
        .poll(() =>
          page.locator(selector).evaluate((el) => {
            const r = el.getBoundingClientRect();
            // Settings is a full-width bottom sheet; site selection is
            // still an inset menu anchored to its trigger.
            const gutter = el.classList.contains("home-settings-menu") ? 0 : 15;
            return (
              r.left >= gutter &&
              r.right <= window.innerWidth - gutter &&
              r.top >= gutter &&
              r.bottom <= window.innerHeight - gutter
            );
          }),
        )
        .toBe(true);
      await page.locator(`${selector} button`).last().focus();
      await expect(page.locator(`${selector} button`).last()).toBeInViewport();
    }
  }
});

test("admin manager picker scrolls to its final action on a short screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.setContent(
    '<!doctype html><html lang="en"><title>Admin overlay check</title><dialog id="choose-compliance-manager-dialog" class="places-modal"><div class="compliance-manager-picker"><h2>Synthetic title</h2><div style="height:800px">Synthetic content</div><button id="admin-last">Confirm</button></div></dialog></html>',
  );
  await page.addStyleTag({
    content: readFileSync(
      new URL("../../admin-frontend/src/styles.css", import.meta.url),
      "utf8",
    ),
  });
  await page.locator("dialog").evaluate((dialog) => {
    if (!(dialog instanceof window.HTMLDialogElement))
      throw new Error("Missing dialog fixture");
    dialog.showModal();
  });
  await page.locator("#admin-last").focus();
  await expect(page.locator("#admin-last")).toBeInViewport();
  expect(
    await page
      .locator("dialog")
      .evaluate((el) => window.getComputedStyle(el).overflowY),
  ).toBe("auto");
});

for (const width of [320, 1280]) {
  test(`kebab follows its trigger and dismisses when scrolled away at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 568 });
    await page.route("**/__anchor_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Menu anchor checks</title><main></main></html>',
      }),
    );
    await page.goto("/__anchor_test");
    await page.evaluate(async () => {
      for (const path of [
        "/src/styles/tokens.css",
        "/src/styles/base.css",
        "/src/components/today-view.css",
      ])
        await import(path);
      const templatePath = "/src/components/today-view.templates.js";
      const { homeActions } = await import(templatePath);
      const helperPath = "/src/lib/menu-viewport.js";
      const { containMenus } = await import(helperPath);
      const host = document.querySelector("main");
      if (!host) throw new Error("Missing fixture host");
      host.innerHTML =
        '<div class="home"><section class="home-region home-region--header">' +
        homeActions({ checkLabel: "Synthetic long check label" }) +
        '</section><div style="height:2000px"></div></div>';
      const containment = containMenus(host);
      const trigger = document.querySelector("#home-action-menu-trigger");
      const menu = document.querySelector(".home-action-menu");
      if (
        !(trigger instanceof window.HTMLElement) ||
        !(menu instanceof window.HTMLElement)
      )
        throw new Error("Missing menu fixture");
      trigger.addEventListener("click", () => {
        menu.hidden = !menu.hidden;
        containment.update();
        trigger.setAttribute("aria-expanded", String(!menu.hidden));
      });
    });
    const trigger = page.locator("#home-action-menu-trigger");
    const menu = page.locator(".home-action-menu");
    await trigger.click();
    await expect
      .poll(() =>
        menu.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const element = document.querySelector("#home-action-menu-trigger");
          if (!element) throw new Error("Missing trigger fixture");
          const trigger = element.getBoundingClientRect();
          const expectedLeft = Math.max(
            16,
            Math.min(
              trigger.right - rect.width,
              window.innerWidth - 16 - rect.width,
            ),
          );
          return Math.abs(rect.left - expectedLeft) < 1;
        }),
      )
      .toBe(true);
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(menu).toBeHidden();
    await trigger.click();
    await expect(menu).toBeVisible();
  });
}
