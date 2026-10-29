import { test, expect } from "@playwright/test";

/** @param {import("@playwright/test").Page} page @param {string} status */
async function fixture(page, status) {
  await page.goto("/");
  await page.evaluate(async (status) => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/today-view.js");
    const { TaskSheets } = await load("/src/components/task-sheets.js");
    const { toggleCardCompletion, isCompletingAnalysisCard } = await load(
      "/src/components/analysis-card-completion.js",
    );
    document.body.innerHTML =
      '<main id="fixture"><article class="analysis-card" data-task-id="lifecycle"><button id="resolve">Resolve</button></article></main><app-toasts></app-toasts>';
    const host = /** @type {HTMLElement} */ (
      document.querySelector("#fixture")
    );
    const card = host.querySelector("article");
    const button = /** @type {HTMLButtonElement} */ (
      host.querySelector("button")
    );
    const task = {
      taskId: "lifecycle",
      status,
      category: "Litter",
      checkId: "check",
      canBeInProgress: false,
    };
    const render = () => {
      if (!isCompletingAnalysisCard(host)) host.dataset.rendered = "true";
    };
    const saved = () => {
      host.dataset.saved = "true";
    };
    if (status === "in_progress") {
      const sheets = new TaskSheets({
        host,
        container: () => host,
        onTaskUpdated: saved,
        reload: render,
      });
      button.addEventListener(
        "click",
        () => void sheets.openUpdates(task, button, "resolve"),
      );
    } else
      button.addEventListener("click", () =>
        toggleCardCompletion(host, card, button, {
          task,
          onSaved: saved,
          render,
        }),
      );
  }, status);
}

for (const status of ["open", "in_progress"]) {
  test(`${status}: save animates the card without opening documentation`, async ({
    page,
  }) => {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(null);
    });
    await page.route("**/v1/tasks/lifecycle/**", async (route) => {
      if (route.request().method() !== "POST")
        return route.fulfill({ json: {} });
      await gate;
      await route.fulfill({
        json: {
          task: {
            taskId: "lifecycle",
            status: "completed",
            latestUpdateId: "saved",
            canUploadPhotos: false,
          },
          update: { updateId: "saved" },
          resultsPending: true,
        },
      });
    });
    await fixture(page, status);
    await page.locator("#resolve").click();
    await expect(page.locator("#resolve")).toHaveAttribute("aria-busy", "true");
    await expect(
      page.locator("task-update-dialog dialog.task-update[open]"),
    ).toHaveCount(0);
    await expect(page.locator(".analysis-card")).toHaveCount(1);
    release();
    await expect(page.locator(".analysis-card--completing")).toBeVisible();
    await expect(page.locator("#fixture")).toHaveAttribute(
      "data-saved",
      "true",
    );
    await expect(page.locator(".analysis-card")).toHaveCount(0);
  });
}
