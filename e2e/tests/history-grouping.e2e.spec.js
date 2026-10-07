// @ts-check
import { test, expect } from "../helpers/harness.js";

for (const width of [393, 1178]) {
  test(`History grouping has a visible label and works by keyboard at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    const tasks = [
      {
        taskId: "history-label-fixture",
        checkId: "history-check",
        kind: "action",
        category: "Litter",
        status: "completed",
        userFriendlyLabel: "Scattered paper",
        createdAt: "2026-09-01T12:00:00Z",
        completedAt: "2026-09-02T12:00:00Z",
      },
    ];
    await page.route("**/v1/tasks?*", (route) =>
      route.fulfill({ json: { tasks } }),
    );
    await page.route("**/v1/checks?*", (route) =>
      route.fulfill({ json: { checks: [] } }),
    );
    await page.goto("/today?filter=history");
    const select = page.locator("#history-grouping");
    const label = select.locator("label");
    const control = select.getByRole("combobox", { name: "Group by" });
    await expect(label).toBeVisible();
    await expect(label).toHaveText("Group by");
    await expect(page.locator(".analysis-tray__check-title")).toHaveText(
      "Sep 2",
    );
    await label.click();
    await expect(control).toBeFocused();
    await control.press("ArrowDown");
    await control.press("Home");
    await control.press("ArrowDown");
    await control.press("Enter");
    await expect(page.locator(".analysis-tray__check-title")).toHaveText(
      "Sep 1",
    );
    await expect(control).toBeFocused();
    await control.press("ArrowDown");
    await control.press("End");
    await control.press("Enter");
    await expect(page.locator(".analysis-tray__check-title")).toHaveText(
      "Litter",
    );
    await expect(control).toBeFocused();
    await expect(page.locator(".history-card__row")).toContainText(
      "Scattered paper",
    );
  });
}
