import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const task = {
  taskId: "issue",
  checkId: "check",
  status: "completing",
  canUpdate: true,
  canUploadPhotos: true,
  userFriendlyLabel: "Graffiti",
  shortId: "GUB-STJ-082",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/v1/tasks/issue/updates", (route) =>
    route.fulfill({ json: { task, updates: [] } }),
  );
  await page.route("**/__update_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Issue updates</title></head><body><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__update_test");
  await page.evaluate(async (task) => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/task-update-dialog.js");
    const { setSite } = await load("/src/db.js");
    await setSite("Test site", { siteId: "test-site", token: "test-token" });
    const dialog = /** @type {any} */ (
      document.createElement("task-update-dialog")
    );
    document.body.append(dialog);
    await dialog.open(task);
    dialog.querySelector("dialog").dataset.testIdentity = "original";
  }, task);
});

/** @param {import("@playwright/test").Page} page */
async function pickPhoto(page) {
  await page.locator('[data-mode="notes"]').click();
  await page
    .locator("[data-photos], [data-update-camera]")
    .setInputFiles("e2e/fixtures/photos/input-1.jpg");
  await expect(page.locator("dialog.task-update")).toHaveAttribute(
    "data-test-identity",
    "original",
  );
  await expect(page.locator("[data-save-notes]")).toBeEnabled();
}

test("all actions are available on a recoverable issue; picking a photo keeps the modal operable", async ({
  page,
}) => {
  for (const mode of ["notes", "action", "resolve"])
    await expect(page.locator(`[data-mode="${mode}"]`)).toBeEnabled();
  await pickPhoto(page);
  await page.evaluate(() => {
    const host = document.querySelector("task-update-dialog");
    host?.remove();
    if (host) document.body.append(host);
  });
  await expect(page.locator("dialog.task-update:modal")).toBeVisible();
  await expect(page.locator("dialog.task-update")).toHaveAttribute(
    "data-test-identity",
    "original",
  );
  await page.locator("[data-add-note], [data-capture-text]").click();
  await page.locator("[data-note-text]").fill("An update");
  await page.locator("[data-save-note]").click();
  await page.locator("[data-close]").click();
  await expect(page.locator("[data-discard-dialog]")).toBeVisible();
  await page.locator("[data-continue-editing]").click();
  await expect(page.locator("[data-save-notes]")).toBeEnabled();
  const results = await new AxeBuilder({ page })
    .include("dialog.task-update")
    .analyze();
  expect(results.violations).toEqual([]);
  await page.locator("[data-close]").focus();
  await page.keyboard.press("Enter");
  await page.locator("[data-confirm-discard]").click();
  await expect(page.locator('[data-mode="notes"]')).toBeVisible();
});

for (const cancelControl of ["data-cancel-save", "data-close"])
  test(`stalled upload can exit via ${cancelControl} and retry without refreshing`, async ({
    page,
  }) => {
    let presigns = 0;
    let saves = 0;
    await page.route("**/v1/checks/check/artifacts:presign", (route) =>
      route.fulfill({
        json: {
          artifactId: `photo-${++presigns}`,
          s3Key: "photo",
          uploadUrl: "http://127.0.0.1:5179/test-upload",
          uploadHeaders: {},
        },
      }),
    );
    await page.route("**/test-upload", () => {});
    await page.route("**/v1/tasks/issue/updates", async (route) => {
      if (route.request().method() === "POST") saves++;
      await route.fulfill({
        json: { task: { ...task, status: "in_progress" }, updates: [] },
      });
    });
    await pickPhoto(page);
    await page.locator("[data-save-notes]").click();
    await expect.poll(() => presigns).toBe(1);
    await expect(page.locator("[data-cancel-save]")).toBeVisible();
    await page.locator(`[${cancelControl}]`).click();
    if (cancelControl === "data-close") {
      await expect(page.locator("[data-discard-dialog]")).toBeVisible();
      await page.locator("[data-continue-editing]").click();
    }
    await expect(page.locator("[data-cancel-save]")).toBeHidden();
    await expect(page.locator("[data-save-notes]")).toBeEnabled();
    expect(saves).toBe(0);
    await page.unroute("**/test-upload");
    await page.route("**/test-upload", (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await page.locator("[data-save-notes]").click();
    await expect(page.locator('[data-mode="notes"]')).toBeVisible();
    expect(saves).toBe(1);
  });

test("an uncertain save times out and retry reuses the update identity", async ({
  page,
}) => {
  /** @type {string[]} */
  const ids = [];
  await page.clock.install();
  await page.route("**/v1/tasks/issue/updates", async (route) => {
    if (route.request().method() === "POST") {
      ids.push(route.request().headers()["idempotency-key"]);
      if (ids.length === 1) return;
    }
    await route.fulfill({
      json: { task: { ...task, status: "in_progress" }, updates: [] },
    });
  });
  await page.locator('[data-mode="notes"]').click();
  await page.locator("[data-add-note], [data-capture-text]").click();
  await page.locator("[data-note-text]").fill("A note to retain");
  await page.locator("[data-save-note]").click();
  await page.locator("[data-save-notes]").click();
  await expect.poll(() => ids.length).toBe(1);
  await page.clock.fastForward(120_000);
  await expect(page.locator("[data-cancel-save]")).toBeHidden();
  await expect(page.locator("[data-edit-note]")).toHaveText("A note to retain");
  await page.locator("[data-save-notes]").click();
  await expect(page.locator('[data-mode="notes"]')).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});
