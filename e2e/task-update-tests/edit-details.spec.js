import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
const catalog = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (/** @type {string} */ key) => catalog[key];

/** @param {import("@playwright/test").Page} page
 * @param {{descriptionOnly?:boolean, fail?:boolean, photo?:boolean, duplicate?:boolean, card?:boolean, dismissible?:boolean, delay?:number}} [options] */
async function mount(
  page,
  {
    descriptionOnly = false,
    fail = false,
    photo = false,
    duplicate = false,
    card = false,
    dismissible = false,
    delay = 0,
  } = {},
) {
  await page.clock.setFixedTime(new Date("2026-11-04T19:00:00Z"));
  /** @type {{url: string, body: Record<string, unknown>}[]} */
  const writes = [];
  const task = {
    ...(photo
      ? {
          mediaUrl:
            "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="200"><rect width="150" height="200" fill="#648e76"/><circle cx="75" cy="100" r="45" fill="#f0d693"/></svg>',
            ),
        }
      : {}),
    ...(descriptionOnly
      ? { conditionId: "condition" }
      : { taskId: "observation" }),
    description: "Wrappers beside the entrance.",
    georeferencedAddress: "Synthetic block entrance",
    createdAt: "2026-10-29T12:00:00Z",
    status: "open",
    category: "Litter",
  };
  await page.route("**/v1/**", async (route) => {
    if (route.request().url().endsWith("/v1/client-events"))
      return route.fulfill({ json: {} });
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          clicked: task,
          members: [{ ...task, isDuplicate: duplicate }],
          selectedRuleId: descriptionOnly ? "" : "LITTER-1",
          revision: 3,
          category: "Litter",
          categories: [
            {
              category: "Litter",
              actions: [
                { ruleId: "LITTER-1", label: "Pick up the litter" },
                {
                  ruleId: "LITTER-2",
                  label: "File 311 ticket",
                  files311: true,
                },
              ],
            },
            {
              category: "Graffiti",
              actions: [{ ruleId: "GRAFFITI-1", label: "Remove the graffiti" }],
            },
          ],
          actions: [
            { ruleId: "LITTER-1", label: "Pick up the litter" },
            { ruleId: "LITTER-2", label: "File 311 ticket" },
          ],
        },
      });
    writes.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: fail && writes.length === 1 ? 503 : 200,
      json: {
        task: {
          ...task,
          status: body.resolved ? "completed" : "in_progress",
          customAction: { resolved: body.resolved },
        },
      },
    });
  });
  await page.route("**/__edit_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit details test</title></head><body><main><button id="trigger">Edit</button></main><app-toasts></app-toasts></body></html>',
    }),
  );
  await page.goto("/__edit_test");
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/main.js");
  });
  await page.evaluate(
    async ({ task, descriptionOnly, card, dismissible }) => {
      const load = (/** @type {string} */ path) => import(path);
      await load("/src/components/app-toasts.js");
      const { setSite } = await load("/src/db.js");
      await setSite("Synthetic site", {
        siteId: "synthetic-site",
        token: "test-token",
      });
      const { openTaskDetails, openDescriptionDetails, showSavedActionCard } =
        await load("/src/components/task-details-dialog.js");
      const problem = {
        title: "Litter near the entrance",
        description: task.description,
        itemId: "photo",
        checkId: "check",
        artifactId: "artifact",
        conditionId: "condition",
        assessmentId: "synthetic-assessment",
      };
      const trigger = document.querySelector("#trigger");
      if (!trigger) throw new Error("Missing edit trigger");
      if (descriptionOnly) openDescriptionDetails(problem, trigger, () => {});
      else {
        if (card) {
          const article = document.createElement("article");
          article.className = "analysis-card";
          article.style.cssText =
            "min-height:240px;max-width:500px;margin:24px auto";
          trigger.before(article);
          article.append(trigger);
        }
        openTaskDetails(
          task,
          problem,
          trigger,
          async (/** @type {{task: Record<string, unknown>}} */ result) => {
            if (!card) return;
            const controller = new window.AbortController();
            if (dismissible) {
              const navigation = document.createElement("button");
              navigation.dataset.testNavigate = "";
              navigation.textContent = "Test navigation";
              navigation.addEventListener("click", () => controller.abort());
              const main = document.querySelector("main");
              if (!main) throw new Error("Missing test main");
              main.prepend(navigation);
            }
            await showSavedActionCard(trigger.closest("article"), result.task, {
              signal: controller.signal,
            });
            return true;
          },
        );
      }
    },
    { task, descriptionOnly, card, dismissible },
  );
  await expect(page.locator("[data-description]")).toBeVisible();
  return writes;
}

/** @param {import("@playwright/test").Page} page @param {string} value */
async function selectAction(page, value) {
  // Keyboard operation exercises the Web Awesome change event and focus path.
  const select = page.locator("[data-action-select]").getByRole("combobox");
  await select.scrollIntoViewIfNeeded();
  await select.focus();
  await select.press("Space");
  await page.locator(`wa-option[value="${value}"]`).click();
}

const editor = (/** @type {import("@playwright/test").Page} */ page) =>
  page.locator("task-details-dialog > dialog").first();

test("edit details drafts actions, returns clean, and saves both fields once", async ({
  page,
}, testInfo) => {
  const writes = await mount(page);
  await selectAction(page, "LITTER-2");
  expect(writes).toHaveLength(0);
  await selectAction(page, "LITTER-1");
  await expect(page.locator("[data-save]")).toBeDisabled();
  await selectAction(page, "LITTER-2");
  await page
    .locator("[data-description]")
    .locator("textarea")
    .fill("Paper wrappers by the door.");
  expect(
    (await new AxeBuilder({ page }).include("task-details-dialog").analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("edit-details.png") });
  await page.locator("[data-save]").click();
  await expect(editor(page)).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({
    ruleId: "LITTER-2",
    description: "Paper wrappers by the door.",
  });
});

for (const dismiss of ["close", "escape", "backdrop", "back"]) {
  test(`edit details guards dirty ${dismiss} dismissal and keeps the draft`, async ({
    page,
  }, testInfo) => {
    const writes = await mount(page);
    await page
      .locator("[data-description]")
      .locator("textarea")
      .fill("A corrected observation.");
    if (dismiss === "close") await page.locator("[data-close]").click();
    if (dismiss === "escape") await page.keyboard.press("Escape");
    if (dismiss === "backdrop") await page.mouse.click(2, 2);
    if (dismiss === "back") await page.evaluate(() => window.history.back());
    await expect(page.locator("[data-discard-dialog]")).toBeVisible();
    if (dismiss === "close")
      await page.screenshot({
        path: testInfo.outputPath("discard-buttons.png"),
        animations: "disabled",
      });
    await page.locator("[data-continue]").click();
    await expect(
      page.locator("[data-description]").locator("textarea"),
    ).toHaveValue("A corrected observation.");
    await page.locator("[data-close]").click();
    await page.locator("[data-discard]").click();
    await expect(editor(page)).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });
}

test("edit details keeps custom resolution in draft until Save", async ({
  page,
}) => {
  const writes = await mount(page);
  await selectAction(page, "__custom__");
  await page
    .locator("[data-custom]")
    .locator("textarea")
    .fill("Asked the site team to help.");
  await page.locator('[data-resolved="no"]').click();
  expect(writes).toHaveLength(0);
  await page.locator("[data-save]").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({
    text: "Asked the site team to help.",
    resolved: false,
  });
});

test("edit details retains a failed save for review and retry", async ({
  page,
}) => {
  const writes = await mount(page, { fail: true });
  await page
    .locator("[data-description]")
    .locator("textarea")
    .fill("A corrected observation.");
  await page.locator("[data-save]").click();
  await expect(editor(page)).toBeVisible();
  await expect(page.locator(".task-details__error")).toHaveText(
    t("taskDetails.saveError"),
  );
  await expect(page.locator("app-toasts")).not.toContainText(
    t("toast.actionSaveError.title"),
  );
  await expect(
    page.locator("[data-description]").locator("textarea"),
  ).toHaveValue("A corrected observation.");
  await page.locator("[data-save]").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0].body).toEqual(writes[1].body);
});

test("edit details description-only mode saves text without changing action or analysis", async ({
  page,
}) => {
  const detailsRequest = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      request.url().includes("/conditions/condition"),
  );
  const writes = await mount(page, { descriptionOnly: true });
  await expect(page.locator(".task-details__member-copy")).toHaveCount(0);
  expect((await detailsRequest).url()).toContain(
    "assessmentId=synthetic-assessment",
  );
  await expect(page.locator("[data-action-select]")).toHaveJSProperty(
    "value",
    null,
  );
  await page
    .locator("[data-description]")
    .locator("textarea")
    .fill("Corrected description of the observation.");
  await page.locator("[data-action-select]").scrollIntoViewIfNeeded();
  const audit = await new AxeBuilder({ page })
    .include("task-details-dialog")
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.locator("[data-save]").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({
    description: "Corrected description of the observation.",
  });
  expect(writes[0].url).toContain(
    "/conditions/condition?assessmentId=synthetic-assessment",
  );
});

test("category changes require a new action and preserve the edited title", async ({
  page,
}) => {
  const writes = await mount(page);
  await page.locator("[data-title]").fill("Paint beside the doorway");
  const category = page.locator("[data-category]").getByRole("combobox");
  await category.focus();
  await category.press("Space");
  await page.locator('wa-option[value="Graffiti"]').click();
  await expect(page.locator("[data-save]")).toBeDisabled();
  await expect(
    page.locator('[data-action-select] wa-option[value="LITTER-2"]'),
  ).toHaveCount(0);
  await selectAction(page, "GRAFFITI-1");
  await expect(page.locator("[data-title]")).toHaveText(
    "Paint beside the doorway",
  );
  await page.locator("[data-save]").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({
    category: "Graffiti",
    ruleId: "GRAFFITI-1",
    title: "Paint beside the doorway",
  });
});
test("a pending question can be replaced by an explicit filing action", async ({
  page,
}) => {
  const writes = await mount(page, { descriptionOnly: true });
  await selectAction(page, "LITTER-2");
  await expect(
    page.getByText(t("details.reportDescriptionHint"), { exact: true }),
  ).toBeVisible();
  await page.locator("[data-save]").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({
    ruleId: "LITTER-2",
    category: "Litter",
    revision: 3,
  });
  expect(writes[0].url).toContain("/conditions/condition");
});

test("the inline title looks editable and portrait thumbnails stay square", async ({
  page,
}, testInfo) => {
  await mount(page, { photo: true });
  const title = page.locator("[data-title]");
  await title.scrollIntoViewIfNeeded();
  await expect(title).toHaveCSS("border-top-style", "solid");
  const location = page.locator("[data-location]");
  const time = page.locator("[data-observed-at]");
  await expect(location).toHaveText("Synthetic block entrance");
  await expect(time.locator("time")).toHaveAttribute(
    "datetime",
    "2026-10-29T12:00:00Z",
  );
  await expect(page.locator(".task-details__header p")).toHaveCount(2);
  const locationBox = await location.boundingBox();
  const timeBox = await time.boundingBox();
  const photoBox = await page.locator(".task-details__thumbnail").boundingBox();
  if (!locationBox || !timeBox || !photoBox)
    throw new Error("Missing observation context");
  expect(timeBox.x).toBeCloseTo(locationBox.x, 0);
  expect(timeBox.y).toBeGreaterThanOrEqual(locationBox.y + locationBox.height);
  expect(photoBox.y).toBeGreaterThanOrEqual(timeBox.y + timeBox.height);
  expect(photoBox.x).toBeCloseTo(locationBox.x, 0);
  const categoryBox = await page.locator("[data-category]").boundingBox();
  if (!categoryBox) throw new Error("Missing category field");
  expect(categoryBox.y).toBeGreaterThanOrEqual(photoBox.y + photoBox.height);
  const triggerBox = await page.locator("[data-photo-lightbox]").boundingBox();
  expect(triggerBox?.height).toBeCloseTo(photoBox.height, 0);
  const image = page.locator(".task-details__thumbnail img");
  await expect(image).toHaveCSS("object-fit", "cover");
  await expect(image).toHaveCSS("width", "180px");
  await expect(image).toHaveCSS("height", "180px");
  await expect(page.locator(".task-details__members")).toHaveCSS(
    "margin-bottom",
    "32px",
  );
  await page.screenshot({ path: testInfo.outputPath("title-thumbnail.png") });
});

test("short draft content keeps the editor full width on desktop", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await mount(page, { photo: true });
  await page.locator("[data-title]").fill("Short title");
  await page.locator("[data-description] textarea").fill("Short note");
  await selectAction(page, "LITTER-2");
  const dialog = editor(page);
  const sheet = dialog.locator(".task-details__sheet");
  const dialogBox = await dialog.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!dialogBox || !sheetBox) throw new Error("Editor is not visible");
  expect(sheetBox.width).toBeCloseTo(dialogBox.width, 0);
  for (const selector of [
    "[data-title]",
    "[data-category]",
    "[data-description]",
    "[data-action-select]",
    "[data-save]",
  ]) {
    const box = await dialog.locator(selector).boundingBox();
    if (!box) throw new Error(`Missing control: ${selector}`);
    expect(box.width).toBeCloseTo(dialogBox.width - 48, 0);
    expect(box.x).toBeCloseTo(dialogBox.x + 24, 0);
  }
  const close = await page.locator("[data-close]").boundingBox();
  if (!close) throw new Error("Close control is not visible");
  expect(close.x + close.width).toBeCloseTo(
    dialogBox.x + dialogBox.width - 24,
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath("full-width-editor.png"),
    animations: "disabled",
  });
});

test("editing a duplicate retains its separation control", async ({ page }) => {
  await mount(page, { photo: true, duplicate: true });
  await expect(page.locator('[data-separate-id="observation"]')).toBeVisible();
  await expect(page.locator("[data-location]")).toHaveText(
    "Synthetic block entrance",
  );
});

test("editor photo opens the lightbox and returns to the unchanged draft", async ({
  page,
}) => {
  await mount(page, { photo: true });
  const title = page.locator("[data-title]");
  await title.fill("Edited draft title");
  const photo = page.locator("task-details-dialog [data-photo-lightbox]");
  await photo.focus();
  await photo.press("Enter");
  await expect(page.locator("photo-lightbox dialog")).toBeVisible();
  await page.locator(".photo-lightbox__close").click();
  await expect(title).toHaveText("Edited draft title");
  await expect(photo).toBeFocused();
});

test("Not yet saves explicitly, shows progress, and confirms the destination on the card", async ({
  page,
}, testInfo) => {
  const writes = await mount(page, { card: true, delay: 800 });
  await selectAction(page, "__custom__");
  await page
    .locator("[data-custom] textarea")
    .fill("Asked the site team to help.");
  await page.locator('[data-resolved="no"]').click();
  await expect(page.locator('[data-resolved="no"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("[data-save-hint]")).toHaveText(
    t("taskDetails.saveUnresolvedHint"),
  );
  expect(writes).toHaveLength(0);
  await expect(page.locator("[data-save]")).toHaveText(
    t("taskDetails.saveAction"),
  );
  await page.locator("[data-save]").click();
  await expect(editor(page)).toBeVisible();
  await expect(page.locator("[data-save]")).toContainText(t("details.saving"));
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeVisible();
  await expect(page.locator("[data-discard-dialog]")).not.toBeVisible();
  const receipt = page.locator(".saved-action-card");
  await expect(receipt).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  await expect(receipt.getByRole("status")).toContainText(
    t("taskDetails.movingUnresolved"),
  );
  await expect(page.locator("[data-view-saved-action]")).toHaveCount(0);
  await expect(receipt.locator(".ellipsis-dots")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await receipt.hover();
  await page.waitForTimeout(2400);
  await expect(receipt).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include("main").analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("action-saved-card.png") });
  // Hovering must not hold the automatic move indefinitely.
  await expect(receipt).toHaveCount(0, { timeout: 8000 });
  expect(writes).toHaveLength(1);
  await expect(page.locator("app-toasts")).not.toContainText(
    t("taskDetails.actionSaved"),
  );
});

test("the saved-action receipt collapses without motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, { card: true });
  await selectAction(page, "__custom__");
  await page
    .locator("[data-custom] textarea")
    .fill("Asked the site team to help.");
  await page.locator('[data-resolved="no"]').click();
  await page.locator("[data-save]").click();
  await expect(page.locator(".saved-action-card")).toBeVisible();
  await expect(page.locator(".saved-action-card")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.mouse.move(0, 0);
  await expect(page.locator(".ellipsis-dots span").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(page.locator(".analysis-card")).toHaveCount(0, {
    timeout: 8000,
  });
});

test("a resolved custom action explains the History destination", async ({
  page,
}) => {
  await mount(page, { card: true });
  await selectAction(page, "__custom__");
  await page
    .locator("[data-custom] textarea")
    .fill("The site team picked up the wrappers.");
  await page.locator('[data-resolved="yes"]').click();
  await expect(page.locator("[data-save-hint]")).toHaveText(
    t("taskDetails.saveResolvedHint"),
  );
  await page.locator("[data-save]").click();
  await expect(page.locator(".saved-action-card [role=status]")).toContainText(
    t("taskDetails.movingResolved"),
  );
  await expect(page.locator("[data-view-saved-action]")).toHaveCount(0);
  await expect(
    page.locator(".saved-action-card .ellipsis-dots"),
  ).toHaveAttribute("aria-hidden", "true");
  await page.locator(".saved-action-card").hover();
  await page.waitForTimeout(2400);
  await expect(page.locator(".saved-action-card")).toBeVisible();
  await expect(page.locator(".saved-action-card")).toHaveCount(0, {
    timeout: 8000,
  });
  await expect(page.locator("app-toasts")).not.toContainText(
    t("taskDetails.actionSaved"),
  );
});

for (const outcome of ["no", "yes"]) {
  test(`empty custom action highlights its required field for outcome ${outcome}`, async ({
    page,
  }) => {
    const writes = await mount(page);
    await selectAction(page, "__custom__");
    const custom = page.locator("[data-custom]");
    await expect(custom).toHaveAttribute("required", "");
    await expect(page.locator(".task-details__custom legend")).toContainText(
      "*",
    );
    const normalColor = await custom.evaluate((element) => {
      const label = element.shadowRoot?.querySelector(
        '[part~="form-control-label"]',
      );
      if (!label) throw new Error("Missing custom action label");
      return window.getComputedStyle(label).color;
    });
    await page.locator(`[data-resolved="${outcome}"]`).click();
    await expect(custom).toHaveAttribute("aria-invalid", "true");
    await expect(custom).toHaveAttribute("data-custom-invalid", "");
    await expect(custom).toHaveJSProperty(
      "hint",
      t("taskDetails.actionRequired"),
    );
    const colors = await custom.evaluate((element) => {
      const label = element.shadowRoot?.querySelector(
        '[part~="form-control-label"]',
      );
      const wrapper = element.shadowRoot?.querySelector(
        '[part~="textarea-wrapper"]',
      );
      if (!label || !wrapper) throw new Error("Missing custom action controls");
      return {
        label: window.getComputedStyle(label).color,
        border: window.getComputedStyle(wrapper).borderTopColor,
        marker: window.getComputedStyle(label, "::after").content,
      };
    });
    expect(colors.label).not.toBe(normalColor);
    expect(colors.border).toBe(colors.label);
    expect(colors.marker).toContain("*");
    await expect(page.locator("[data-save]")).toBeDisabled();
    await custom.locator("textarea").fill("   ");
    await expect(custom).toHaveAttribute("aria-invalid", "true");
    await custom.locator("textarea").fill("Asked the site team to help.");
    await expect(custom).toHaveAttribute("aria-invalid", "false");
    await expect(custom).not.toHaveAttribute("data-custom-invalid", "");
    await expect(custom).toHaveJSProperty("hint", "");
    await expect(page.locator("[data-save]")).toBeEnabled();
    expect(writes).toHaveLength(0);
  });
}

test("navigation immediately clears a saved-action overlay without collapsing its card", async ({
  page,
}) => {
  await mount(page, { card: true, dismissible: true });
  await selectAction(page, "__custom__");
  await page
    .locator("[data-custom] textarea")
    .fill("Asked the site team to help.");
  await page.locator('[data-resolved="no"]').click();
  await page.locator("[data-save]").click();
  await expect(page.locator(".saved-action-card")).toBeVisible();
  await page.locator("[data-test-navigate]").click();
  await expect(page.locator(".saved-action-card")).toHaveCount(0, {
    timeout: 1000,
  });
  await expect(page.locator(".analysis-card")).toBeVisible();
  await expect(page.locator(".saved-action-exit")).toHaveCount(0);
  await expect(page.locator("#trigger")).toBeEnabled();
});
