import { test, expect } from "@playwright/test";
for (const knownTask of [true, false]) {
  test(`saved action does not depend on the documentation dialog (known task: ${knownTask})`, async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/v1/tasks/save-fixture/complete", async (route) => {
      requests++;
      await route.fulfill({
        json: {
          task: {
            taskId: "save-fixture",
            status: "completed",
            latestUpdateId: "event",
          },
          resultsPending: true,
        },
      });
    });
    await page.goto("/");
    const result = await page.evaluate(async (known) => {
      const load = (/** @type {string} */ path) => import(path);
      await window.customElements.whenDefined("app-toasts");
      const { completeCardAction } = await load(
        "/src/components/analysis-card-completion.js",
      );
      document.body.innerHTML = "<app-toasts></app-toasts>";
      return completeCardAction(
        "save-fixture",
        { completionMethod: "manual" },
        {
          task: known
            ? { taskId: "save-fixture", canBeInProgress: false }
            : null,
        },
      );
    }, knownTask);
    expect(result.task.status).toBe("completed");
    await expect(page.locator("task-update-dialog")).toHaveCount(0);
    expect(requests).toBe(1);
  });
}
