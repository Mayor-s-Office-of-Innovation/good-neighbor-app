import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";
import { routeHomeLists } from "../helpers/app.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [] } }),
  );
  // Home reads its lists through GET /v1/home, which needs the section shape.
  await routeHomeLists(page);
  await page.route("**/__support_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Support test</title></head><body><main></main><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__support_test");
  await page.evaluate(async () => {
    await window.customElements.whenDefined("today-view");
    const dbPath = "/src/db.js";
    const { setSite } = await import(dbPath);
    await setSite("Support test site", {
      siteId: "support-test",
      token: "mock-token",
    });
    // Use the production app shell, route table, lazy loading, and history.
    document.querySelector("main")?.remove();
    document.body.append(document.createElement("app-root"));
  });
  await expect(page.locator("#home-settings")).toBeEnabled();
  await page.locator("#home-settings").click();
  await page.locator("#settings-help").click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.locator("support-view h1")).toHaveText(t("support.title"));
});

test("Ask requires 20 trimmed characters and clears validation after sending", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/v1/support", (route) => {
    requests++;
    return route.fulfill({
      json: { outcome: "unknown", answer: "", sources: [] },
    });
  });
  const field = page.locator("support-view textarea");
  const send = page.locator("[data-send]");
  const hint = page.locator("[data-question-hint]");
  await expect(send).toBeDisabled();
  await expect(hint).toBeHidden();
  await field.fill("  " + "a".repeat(19) + "  ");
  await expect(send).toBeDisabled();
  await expect(hint).toHaveText(t("support.questionHint"));
  await expect(hint).toBeVisible();
  expect(requests).toBe(0);
  await field.fill("a".repeat(20));
  await expect(send).toBeEnabled();
  await expect(hint).toBeHidden();
  await send.click();
  await expect(page.locator(".support__turn")).toHaveCount(1);
  expect(requests).toBe(1);
  await expect(field).toHaveValue("");
  await expect(send).toBeDisabled();
  await expect(hint).toBeHidden();
});

test("Help is a screen in the navigation stack and clears on leaving", async ({
  page,
}) => {
  await expect(page.locator("support-view dialog")).toHaveCount(0);
  await expect(page.locator("today-view")).toHaveCount(0);
  await page.route("**/v1/support", (route) =>
    route.fulfill({ json: { outcome: "unknown", answer: "", sources: [] } }),
  );
  await page.locator("support-view textarea").fill("How do I finish my check?");
  await page.locator("[data-send]").click();
  await expect(page.locator(".support__turn")).toHaveCount(1);
  await page.locator("support-view [data-menu-back]").click();
  await expect(page.locator("today-view")).toBeVisible();
  await expect(page.locator("support-view")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("support-view")).toBeVisible();
  await expect(page.locator(".support__turn")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("today-view")).toBeVisible();
});

test("responses cite sources, collapse and clear", async ({ page }) => {
  await page.route("**/v1/support", (route) =>
    route.fulfill({
      json: {
        outcome: "answered",
        answer: "One photo or a description. <script>unsafe()</script>",
        sources: [
          {
            id: "FAQ-13",
            title: "Why is Finish check unavailable?",
            text: "One photo or one saved description.",
          },
        ],
      },
    }),
  );
  for (const question of [
    "How do I finish my first check?",
    "How do I finish my second check?",
  ]) {
    await page.locator("support-view textarea").fill(question);
    await page.locator("[data-send]").click();
    await expect(page.locator(".support__turn").last()).toContainText(question);
  }
  const first = page.locator(".support__turn").first();
  await expect(first.locator("script")).toHaveCount(0);
  await first.locator(".support__source summary").click();
  await expect(first.locator(".support__source p")).toBeVisible();
  const sourceSpacing = await first
    .locator(".support__source summary")
    .evaluate((el) => {
      if (!el.parentElement) throw new Error("Missing source container");
      const source = el.parentElement.getBoundingClientRect();
      const summary = el.getBoundingClientRect();
      return {
        inset: summary.left - source.left,
        padding: parseFloat(window.getComputedStyle(el).paddingLeft),
        fits: summary.right <= source.right,
      };
    });
  expect(sourceSpacing.inset).toBeGreaterThanOrEqual(0);
  expect(sourceSpacing.padding).toBeGreaterThanOrEqual(16);
  expect(sourceSpacing.fits).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("support-source-spacing.png"),
  });
  const toggle = first.locator(".support__sources-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(first.locator(".support__sources")).toBeHidden();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(first.locator(".support__source p")).toBeVisible();
  await page.locator("[data-clear]").click();
  await expect(page.locator(".support__turn")).toHaveCount(0);
  await expect(page.locator("support-view textarea")).toBeFocused();
});

test("shows safe fallbacks and email", async ({ page }) => {
  for (const outcome of ["unknown", "off_topic", "limited", "unavailable"]) {
    await page.route("**/v1/support", (route) =>
      route.fulfill(
        outcome === "limited"
          ? { status: 429, json: {} }
          : outcome === "unavailable"
            ? { status: 503, json: {} }
            : { json: { outcome, answer: "", sources: [] } },
      ),
    );
    await page
      .locator("support-view textarea")
      .fill("Please help me finish my check");
    await page.locator("[data-send]").click();
    await expect(page.locator(".support__turn").last()).toContainText(
      t(`support.${outcome === "off_topic" ? "offTopic" : outcome}`),
    );
    await page.unroute("**/v1/support");
  }
  await expect(page.locator(".support__email")).toHaveAttribute(
    "href",
    "mailto:goodneighbor@sf.gov",
  );
});

test("leaving aborts pending answers and prevents stale updates", async ({
  page,
}) => {
  /** @type {(() => void) | undefined} */
  let release;
  const pending = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  let count = 0;
  await page.route("**/v1/support", async (route) => {
    count++;
    await pending;
    await route
      .fulfill({ json: { outcome: "unknown", answer: "", sources: [] } })
      .catch(() => {});
  });
  await page.locator("support-view textarea").fill("How do I finish my check?");
  await page.locator("[data-send]").click();
  await expect.poll(() => count).toBe(1);
  await expect(page.locator("[data-send]")).toBeDisabled();
  await page.locator("support-view [data-menu-back]").click();
  await expect(page.locator("support-view")).toHaveCount(0);
  release?.();
  await page.goForward();
  await expect(page.locator("support-view")).toBeVisible();
  await expect(page.locator(".support__turn")).toHaveCount(0);
});

test("fits desktop and mobile and passes accessibility", async ({ page }) => {
  for (const width of [1136, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page
        .locator(".support__panel")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await page.locator("support-view [data-menu-back]").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-starter]").first()).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  await expect(page.locator("support-view textarea")).toBeFocused();
  const results = await new AxeBuilder({ page })
    .include("support-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("direct Help loads and refreshes work, with Home as the Back fallback", async ({
  page,
}) => {
  const direct = await page.context().newPage();
  await direct.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [] } }),
  );
  await routeHomeLists(direct);
  await direct.goto("/help");
  await expect(direct.locator("support-view h1")).toHaveText(
    t("support.title"),
  );
  await direct.reload();
  await expect(direct.locator("support-view h1")).toHaveText(
    t("support.title"),
  );
  await direct.locator("support-view [data-menu-back]").click();
  await expect(direct).toHaveURL(/\/today$/);
  await expect(direct.locator("today-view")).toBeVisible();
  await direct.close();
});

test("starters submit once and return when the conversation is cleared", async ({
  page,
}) => {
  /** @type {string[]} */
  const questions = [];
  await page.route("**/v1/support", (route) => {
    questions.push(route.request().postDataJSON().question);
    return route.fulfill({ json: { outcome: "unknown" } });
  });
  const starters = page.locator("[data-starters]");
  const first = page.locator("[data-starter]").first();
  const question = (await first.locator("span").textContent())?.trim() || "";
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".support__turn")).toHaveCount(1);
  expect(questions).toEqual([question]);
  await expect(starters).toBeHidden();
  await expect(page.locator("support-view textarea")).toHaveValue("");
  await page.locator("[data-clear]").click();
  await expect(page.locator(".support__turn")).toHaveCount(0);
  await expect(starters).toBeVisible();
  await expect(page.locator("support-view textarea")).toBeFocused();
});
