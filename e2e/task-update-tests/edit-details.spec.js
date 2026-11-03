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
 * @param {{descriptionOnly?:boolean, fail?:boolean, photo?:boolean}} [options] */
async function mount(
  page,
  { descriptionOnly = false, fail = false, photo = false } = {},
) {
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
    taskId: "observation",
    description: "Wrappers beside the entrance.",
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
          members: [task],
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
    await route.fulfill({
      status: fail && writes.length === 1 ? 503 : 200,
      json: { task },
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
    async ({ task, descriptionOnly }) => {
      const load = (/** @type {string} */ path) => import(path);
      await load("/src/components/app-toasts.js");
      const { setSite } = await load("/src/db.js");
      await setSite("Synthetic site", {
        siteId: "synthetic-site",
        token: "test-token",
      });
      const { openTaskDetails, openDescriptionDetails } = await load(
        "/src/components/task-details-dialog.js",
      );
      const problem = {
        title: "Litter near the entrance",
        description: task.description,
        itemId: "photo",
        checkId: "check",
        artifactId: "artifact",
        conditionId: "condition",
      };
      const trigger = document.querySelector("#trigger");
      if (descriptionOnly) openDescriptionDetails(problem, trigger, () => {});
      else openTaskDetails(task, problem, trigger, () => {});
    },
    { task, descriptionOnly },
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
  await page.locator('[data-resolved="false"]').click();
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
  await expect(editor(page)).toHaveCount(0);
  await page.getByRole("button", { name: t("details.reviewRetry") }).click();
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
  const writes = await mount(page, { descriptionOnly: true });
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
  expect(writes[0].url).toContain("/conditions/condition");
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
  const image = page.locator(".task-details__thumbnail img");
  await expect(image).toHaveCSS("object-fit", "cover");
  await expect(image).toHaveCSS("width", "75px");
  await expect(image).toHaveCSS("height", "75px");
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
