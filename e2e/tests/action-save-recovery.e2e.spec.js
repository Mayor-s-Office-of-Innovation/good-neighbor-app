import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";

for (const knownTask of [true, false]) {
  test(`saved action survives unavailable results module (known task: ${knownTask})`, async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/src/components/task-update-dialog.js*", (route) =>
      route.abort(),
    );
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
      await customElements.whenDefined("app-toasts");
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
    await expect(
      page.getByText(t("taskUpdate.formUnavailableResolved")),
    ).toBeVisible();
    await expect(page.getByText(t("toast.actionSaveError.title"))).toHaveCount(
      0,
    );
    await page
      .getByRole("button", { name: t("common.retry"), exact: true })
      .click();
    await expect(
      page.getByText(t("taskUpdate.formUnavailableResolved")).first(),
    ).toBeVisible();
    expect(requests).toBe(1);
  });
}
