// @ts-check
import { test, expect } from "../helpers/harness.js";

const task = {
  taskId: "history-timeline",
  checkId: "history-check",
  status: "completed",
  category: "Litter",
  createdAt: new Date(Date.now() - 86400000).toISOString(),
  completedAt: new Date().toISOString(),
  canBeInProgress: false,
};

/** @param {import('@playwright/test').Page} page */
async function history(page) {
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({
      json: {
        tasks:
          new URL(route.request().url()).searchParams.get("status") ===
          "completed"
            ? [task]
            : [],
      },
    }),
  );
  await page.route("**/v1/checks?*", (route) =>
    route.fulfill({ json: { checks: [] } }),
  );
  await page.goto("/today?filter=history");
  await page
    .locator('[data-task-id="history-timeline"] [data-action="update"]')
    .click();
}

test("History timeline loads while City details and evidence requests are stalled", async ({
  page,
}) => {
  let release = () => {};
  const pending = new Promise((resolve) => {
    release = () => resolve(null);
  });
  await page.route("**/v1/tasks/history-timeline/updates", (route) =>
    route.fulfill({
      json: {
        task: {
          ...task,
          appActionResults: [
            {
              code: "create_311_ticket",
              payload: { tickets: [{ srNum: "LOCAL-HISTORY" }] },
            },
          ],
        },
        updates: [
          {
            type: "note",
            occurredAt: task.completedAt,
            text: "Saved timeline activity",
            photoKeys: ["photo"],
          },
        ],
      },
    }),
  );
  await page.route("**/v1/311-requests:batch", async (route) => {
    await pending;
    await route.abort();
  });
  await page.route(
    "**/v1/checks/history-check/artifacts/photo/media",
    async (route) => {
      await pending;
      await route.abort();
    },
  );
  try {
    await history(page);
    await expect(page.locator("dialog.task-update[open]")).toContainText(
      "Saved timeline activity",
    );
  } finally {
    release();
  }
});

test("History timeline errors offer a working retry on the same card", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/v1/tasks/history-timeline/updates", (route) =>
    route.fulfill(
      fail
        ? { status: 503, json: { error: "unavailable" } }
        : {
            json: {
              task,
              updates: [
                {
                  type: "note",
                  occurredAt: task.completedAt,
                  text: "Recovered timeline activity",
                },
              ],
            },
          },
    ),
  );
  await history(page);
  const dialog = page.locator("dialog.task-update[open]");
  await expect(dialog.locator("[data-retry-timeline]")).toBeVisible();
  fail = false;
  await dialog.locator("[data-retry-timeline]").click();
  await expect(dialog).toContainText("Recovered timeline activity");
});
