// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";

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

for (const width of [390, 1280]) {
  test(`retrying an older History page retains earlier pages at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let fail = true;
    await page.route("**/v1/tasks/history-timeline/updates*", (route) => {
      const token = new URL(route.request().url()).searchParams.get(
        "nextToken",
      );
      if (token === "page3" && fail)
        return route.fulfill({ status: 503, json: { error: "offline" } });
      const index = token === "page3" ? 3 : token === "page2" ? 2 : 1;
      return route.fulfill({
        json: {
          task,
          updates: [
            {
              updateId: `event-${index}`,
              type: "note",
              occurredAt: task.completedAt,
              text: `Activity page ${index}`,
            },
          ],
          nextToken: index < 3 ? `page${index + 1}` : null,
        },
      });
    });
    await history(page);
    const dialog = page.locator("dialog.task-update[open]");
    await dialog.locator("[data-load-older]").click();
    await expect(dialog).toContainText("Activity page 2");
    await dialog.locator("[data-load-older]").click();
    await expect(dialog.locator("[data-retry-timeline]")).toBeVisible();
    fail = false;
    await dialog.locator("[data-retry-timeline]").click();
    for (const index of [1, 2, 3])
      await expect(dialog).toContainText(`Activity page ${index}`);
  });
}

test("City enrichment preserves focus on a later photo", async ({ page }) => {
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
            updateId: "photos",
            type: "note",
            occurredAt: task.completedAt,
            photoKeys: ["first", "second"],
          },
        ],
      },
    }),
  );
  await page.route("**/v1/checks/history-check/artifacts/*/media", (route) =>
    route.fulfill({
      json: {
        downloadUrl:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
      },
    }),
  );
  await page.route("**/v1/311-requests:batch", async (route) => {
    await pending;
    await route.fulfill({
      json: {
        requests: [
          {
            taskId: task.taskId,
            request: {
              status: "Closed",
              events: [
                {
                  kind: "resolved",
                  title: "City enrichment arrived",
                  occurredAt: task.completedAt,
                },
              ],
            },
          },
        ],
      },
    });
  });
  try {
    await history(page);
    const dialog = page.locator("dialog.task-update[open]");
    const photos = dialog.locator("[data-timeline-focus]");
    await expect(photos).toHaveCount(2);
    await photos.nth(1).focus();
    const key = await photos.nth(1).getAttribute("data-timeline-focus");
    release();
    await expect(dialog).toContainText(t("card.ticker.cityClosed"));
    await expect(photos.nth(1)).toBeFocused();
    await expect(photos.nth(1)).toHaveAttribute(
      "data-timeline-focus",
      key || "",
    );
  } finally {
    release();
  }
});
