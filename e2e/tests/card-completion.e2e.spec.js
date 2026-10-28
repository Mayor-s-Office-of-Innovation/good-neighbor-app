// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";

test("checklist waits for confirmed save, recovers from failure, and opens completion history", async ({
  page,
}) => {
  // Keep the task inside Today's 14-day active window on every test run.
  const createdAt = Date.now() - 5 * 60 * 1000;
  let task = {
    taskId: "completion-fixture",
    checkId: "completion-check",
    kind: "action",
    category: "Litter",
    status: "open",
    userFriendlyLabel: "Scattered paper",
    ruleId: "LITTER-1",
    canBeInProgress: false,
    completionMethod: "user_confirmed",
    buttons: ["We picked this up"],
    createdAt: new Date(createdAt).toISOString(),
    completedAt: "",
  };
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({ json: { tasks: [task] } }),
  );
  await page.route("**/v1/checks?*", (route) =>
    route.fulfill({ json: { checks: [] } }),
  );
  let fail = true;
  let release = () => {};
  /** @type {Promise<void>} */
  const saved = new Promise((resolve) => {
    release = resolve;
  });
  let requested = () => {};
  /** @type {Promise<void>} */
  const saving = new Promise((resolve) => {
    requested = resolve;
  });
  await page.route("**/v1/tasks/completion-fixture/complete", async (route) => {
    if (fail) {
      await route.fulfill({
        status: 500,
        json: { error: "test-save-failure" },
      });
      return;
    }
    requested();
    await saved;
    task = {
      ...task,
      status: "completed",
      completedAt: new Date(createdAt + 5 * 60 * 1000).toISOString(),
    };
    await route.fulfill({ json: { task } });
  });
  await page.route("**/v1/tasks/completion-fixture/updates", (route) =>
    route.fulfill({
      json: {
        task,
        updates: [
          {
            type: "task_completed",
            label: "Marked as complete",
            occurredAt: task.completedAt,
          },
        ],
      },
    }),
  );
  await page.goto("/today?filter=todo");
  const card = page.locator('[data-task-id="completion-fixture"]');
  const checkbox = card.getByRole("checkbox", {
    name: t("rulebook.button.pick-up-the-litter-5088"),
  });
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).not.toBeChecked();
  await expect(card).toBeVisible();
  fail = false;
  try {
    await checkbox.click();
    await saving;
    await expect(card).toBeVisible();
    await expect(checkbox).toBeDisabled();
    await expect(page.locator(".analysis-card--completing")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(card).toHaveCount(0);
  await page.locator('[data-home-filter="history"]').click();
  await expect(card).toContainText(t("card.history.minutes", { count: 5 }));
  await expect(card.locator('[data-analysis-action="edit"]')).toHaveCount(0);
  await expect(card.locator("[data-status-ticker]")).toHaveCount(0);
  await card.getByRole("button").click();
  const dialog = page.locator("dialog.task-update[open]");
  await expect(dialog).toContainText(t("taskUpdate.siteResolved"));
  await expect(dialog.locator("[data-status-ticker]")).toHaveCount(0);
  await expect(dialog.locator(".task-update__route")).toHaveCount(0);
  await expect(dialog.locator(".task-update__metadata")).toHaveCount(0);
});
