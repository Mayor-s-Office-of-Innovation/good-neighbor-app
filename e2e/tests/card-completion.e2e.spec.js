// @ts-check
import { test, expect } from "../helpers/harness.js";

test("checklist waits for confirmed save, recovers from failure, and opens completion history", async ({
  page,
}) => {
  let task = {
    taskId: "completion-fixture",
    checkId: "completion-check",
    kind: "action",
    category: "Litter",
    status: "open",
    userFriendlyLabel: "Scattered paper",
    ruleId: "LITTER-1",
    buttons: ["We picked this up"],
    createdAt: "2026-09-01T12:00:00Z",
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
      completedAt: "2026-09-01T12:05:00Z",
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
  const checkbox = card.getByRole("checkbox", { name: "Pick up the litter" });
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
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(card).toContainText("took 5 minutes");
  await expect(card.getByRole("button", { name: "Edit details" })).toHaveCount(
    0,
  );
  await card.getByRole("button").click();
  const dialog = page.locator("dialog.task-update[open]");
  await expect(dialog).toContainText("Marked as complete");
  await expect(dialog.locator(".task-update__route")).toContainText(
    "On-site action",
  );
  await expect(dialog.locator(".task-update__metadata")).toHaveCount(0);
});
