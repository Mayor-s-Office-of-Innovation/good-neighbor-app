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
  await page.evaluate(() => window.customElements.whenDefined("today-view"));
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
    const style = window.getComputedStyle(el);
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
      window.getComputedStyle(el).fontSize,
      window.getComputedStyle(el, "::placeholder").fontSize,
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
    const Base = /** @type {any} */ (window.customElements.get("today-view"));
    class FilingTest extends Base {
      connectedCallback() {}
      disconnectedCallback() {}
    }
    window.customElements.define(
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

for (const theme of ["light", "dark"]) {
  test(`lightbox failed image shows unavailable-image icon, text and a retry (${theme})`, async ({
    page,
  }) => {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("wa-dark", theme === "dark");
    }, theme);
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
    // Axe must sample the settled colors, not the dialog entrance fade.
    await expect(page.locator(".photo-lightbox")).toHaveCSS("opacity", "1");
    const results = await new AxeBuilder({ page })
      .include("photo-lightbox")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("lightbox-error.png"),
    });
  });
}

for (const failedPreview of [false, true]) {
  test(`failed photo restores focus after thumbnail replacement (preview failure: ${failedPreview})`, async ({
    page,
  }) => {
    await page.evaluate(async (failedPreview) => {
      const path = "/src/components/photo-lightbox.js";
      const { openPhotoLightbox } = await import(path);
      window.customElements.define(
        "capture-photo",
        class extends window.HTMLElement {
          async original({ previewOnly = false } = {}) {
            return {
              src:
                previewOnly && failedPreview
                  ? "data:image/png;base64,YmFkMg=="
                  : "data:image/png;base64,YmFk",
              release() {},
            };
          }
        },
      );
      const host = document.querySelector("main");
      if (!host) throw new Error("Missing photo fixture");
      host.innerHTML =
        '<button id="original-photo" data-photo-lightbox data-full-src="data:image/png;base64,YmFk"><capture-photo data-media-key="synthetic-photo"><img src="data:image/png;base64,YmFk" alt="Synthetic photo"></capture-photo></button>';
      await openPhotoLightbox(host, host.querySelector("button"), host);
    }, failedPreview);
    await expect(page.locator(".photo-lightbox__recovery")).toBeVisible();
    await expect(page.locator(".photo-lightbox__image")).toBeHidden();
    await page.evaluate(() => {
      const original = document.querySelector("#original-photo");
      if (!original) throw new Error("Missing original photo");
      const replacement = /** @type {HTMLElement} */ (original.cloneNode(true));
      replacement.id = "replacement-photo";
      original.replaceWith(replacement);
    });
    await expect(page.locator(".photo-lightbox")).toBeVisible();
    await page.locator(".photo-lightbox__close").click();
    await expect(page.locator("#replacement-photo")).toBeFocused();
  });
}

test("zoomed complaint entry brings the focused editor into the visual viewport", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Pinch zoom emulation uses Chromium CDP",
  );
  await page.evaluate(async () => {
    const viewPath = "/src/components/complaint-view.js";
    const routePath = "/src/router.js";
    await import(viewPath);
    const { navigate } = await import(routePath);
    navigate("/complaints/new");
    const Base = /** @type {any} */ (window.customElements.get("app-root"));
    class ZoomRoot extends Base {
      connectedCallback() {
        this._startKeyboardViewportSync();
      }
      disconnectedCallback() {
        this._stopKeyboardViewportSync();
      }
    }
    window.customElements.define(
      "zoom-root",
      /** @type {CustomElementConstructor} */ (
        /** @type {unknown} */ (ZoomRoot)
      ),
    );
    const root = document.createElement("zoom-root");
    root.innerHTML =
      '<complaint-view></complaint-view><div style="height:1000px" aria-hidden="true"></div>';
    document.querySelector("main")?.append(root);
  });
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.evaluate(() => {
      const button = document.querySelector("#describe-complaint");
      if (!button || !window.visualViewport)
        throw new Error("Missing zoom fixture");
      window.scrollTo(
        0,
        window.scrollY +
          button.getBoundingClientRect().bottom -
          window.visualViewport.height +
          8,
      );
      // Activate a button positioned near the visible viewport's bottom.
      // Locator.click would first auto-scroll and conceal this regression.
      /** @type {HTMLElement} */ (button).click();
    });
    await expect(page.locator("#complaint-description")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const field = document.querySelector("#complaint-description");
          const viewport = window.visualViewport;
          if (!field || !viewport) return false;
          const bounds = field.getBoundingClientRect();
          return (
            bounds.top >= viewport.offsetTop &&
            bounds.bottom <= viewport.offsetTop + viewport.height
          );
        }),
      )
      .toBe(true);
  } finally {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await session.detach();
  }
});

test("background check completion preserves the current single-issue controls", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const sessionPath = "/src/state/check-session.js";
    const componentPath = "/src/components/problem-report.js";
    const session = await import(sessionPath);
    const dbPath = "/src/db.js";
    const { setSite } = await import(dbPath);
    await setSite("Synthetic site", { siteId: "synthetic-site" });
    const previous = session.startCheck("synthetic-site");
    session.addItem({ kind: "text", text: "Synthetic finished issue" });
    session.markCaptureComplete({ checkId: previous.id });
    session.startProblemReport("synthetic-site");
    session.addItem({ kind: "text", text: "Synthetic current issue" });
    await import(componentPath);
    const report = document.createElement("problem-report");
    report.dataset.previousCheck = previous.id;
    document.querySelector("main")?.append(report);
  });
  const controls = page.locator("#problem-footer button").first();
  await expect(controls).toBeEnabled();
  await controls.focus();
  await expect(controls).toBeFocused();
  await controls.evaluate((button) =>
    button.setAttribute("data-preserved", "true"),
  );
  await page.evaluate(async () => {
    const sessionPath = "/src/state/check-session.js";
    const session = await import(sessionPath);
    const report = document.querySelector("problem-report");
    session.markScorecardDone(report?.getAttribute("data-previous-check"));
  });
  await expect(controls).toHaveAttribute("data-preserved", "true");
  await expect(controls).toBeFocused();
});
