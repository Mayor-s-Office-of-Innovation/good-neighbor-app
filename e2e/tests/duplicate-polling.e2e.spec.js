// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";
import { t } from "../helpers/i18n.js";

/** Real Home and polling service with controlled duplicate API outcomes.
 * @param {import('@playwright/test').Page} page
 */
async function fixture(page) {
  await bindSite(page);
  const createdAt = new Date().toISOString();
  const tasks = ["settled", "waiting"].map((taskId) => ({
    taskId,
    checkId: "polling-check",
    conditionId: taskId,
    category: "Litter",
    kind: "action",
    status: "open",
    createdAt,
    updatedAt: createdAt,
    userFriendlyLabel: `Synthetic polling issue ${taskId}`,
  }));
  const state = { pending: true, batches: /** @type {string[][]} */ ([]) };
  await page.route("**/v1/site", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.site.featureFlags = {
      ...body.site.featureFlags,
      duplicateDetection: true,
    };
    await route.fulfill({ json: body });
  });
  await page.route("**/v1/guidance/pending*", (route) =>
    route.fulfill({ json: { guidance: [] } }),
  );
  await page.route("**/v1/checks?*", (route) =>
    route.fulfill({ json: { checks: [] } }),
  );
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({
      json: {
        tasks:
          new URL(route.request().url()).searchParams.get("status") === "open"
            ? tasks
            : [],
      },
    }),
  );
  await page.route("**/v1/duplicates:batch", async (route) => {
    const { taskIds } = route.request().postDataJSON();
    state.batches.push(taskIds);
    await route.fulfill({
      json: {
        enabled: true,
        issues: taskIds.map((/** @type {string} */ taskId) => ({
          taskId,
          state: state.pending && taskId === "waiting" ? "pending" : "complete",
        })),
      },
    });
  });
  await page.route("**/v1/tasks/settled/action", (route) =>
    route.fulfill({ json: { task: tasks[0] } }),
  );
  await page.clock.install();
  await page.reload();
  await expect(
    page.locator('.analysis-card[data-task-id="waiting"]'),
  ).toContainText(t("card.ticker.checking"));
  return state;
}

/** @param {import('@playwright/test').Page} page */
async function mutate(page) {
  await page.evaluate(async () => {
    const path = "/src/services/api.js";
    await (await import(path)).updateTaskAction("settled", "synthetic-rule");
  });
}

test("Home polls only pending rows, reuses settled results on return and reconnect, and refreshes after a mutation", async ({
  page,
}) => {
  const state = await fixture(page);
  const settled = page.locator('.analysis-card[data-task-id="settled"]');
  await expect(settled).toContainText(t("card.ticker.needsAction"));
  await page.clock.fastForward(3000);
  await expect.poll(() => state.batches.length).toBeGreaterThanOrEqual(2);
  expect(state.batches.slice(1).every((ids) => ids.join() === "waiting")).toBe(
    true,
  );
  state.pending = false;
  await page.clock.fastForward(6000);
  await expect(
    page.locator('.analysis-card[data-task-id="waiting"]'),
  ).toContainText(t("card.ticker.needsAction"));
  const count = state.batches.length;
  await page.clock.fastForward(60_000);
  expect(state.batches).toHaveLength(count);

  await page.locator("#home-settings").click();
  await page.locator("#settings-help").click();
  await expect(page).toHaveURL(/\/help$/);
  await page.locator("support-view [data-back]").click();
  await expect(settled).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new window.Event("online")));
  await page.clock.fastForward(60_000);
  await expect(settled).toContainText(t("card.ticker.needsAction"));
  expect(state.batches).toHaveLength(count);

  await mutate(page);
  await page.clock.runFor(1);
  await expect.poll(() => state.batches.length).toBe(count + 1);
  expect([...(state.batches.at(-1) ?? [])].sort()).toEqual([
    "settled",
    "waiting",
  ]);
  await expect(settled).toContainText(t("card.ticker.needsAction"));
});

test("Home keeps listening for mutations after its pending retry budget expires", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.clock.fastForward(16 * 60 * 1000);
  const waiting = page.locator('.analysis-card[data-task-id="waiting"]');
  await expect(waiting).toContainText(t("card.ticker.needsAction"));
  const count = state.batches.length;
  await page.clock.fastForward(60_000);
  expect(state.batches).toHaveLength(count);
  state.pending = false;
  await mutate(page);
  await page.clock.runFor(1);
  await expect.poll(() => state.batches.length).toBe(count + 1);
  await expect(waiting).toContainText(t("card.ticker.needsAction"));
});
