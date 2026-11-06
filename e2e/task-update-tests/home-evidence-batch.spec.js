import { test, expect } from "@playwright/test";
import { routeHomeLists } from "../helpers/app.js";

test("the first To-do card is usable while its evidence batch is outstanding", async ({
  page,
}) => {
  const tasks = ["a", "b"].map((id) => ({
    taskId: id,
    checkId: id,
    conditionId: id,
    sourceArtifactIds: ["note"],
    category: "Litter",
    kind: "action",
    status: "open",
    createdAt: new Date().toISOString(),
  }));
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {string[][]} */
  const batches = [];
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { sites: [], guidance: [], issues: [] } }),
  );
  await routeHomeLists(page, {
    tasks: (/** @type {string} */ status) => (status === "open" ? tasks : []),
  });
  await page.route("**/v1/checks:evidence", async (route) => {
    /** @type {{checkIds: string[]}} */
    const { checkIds } = route.request().postDataJSON();
    batches.push(checkIds);
    await gate;
    await route.fulfill({
      json: {
        results: checkIds.map((checkId) => ({
          checkId,
          status: 200,
          artifacts: [{ artifactId: "note", text: "Synthetic note" }],
        })),
      },
    });
  });
  await page.route("**/__home_batch", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><title>Home evidence test</title><body></body></html>',
    }),
  );
  await page.goto("/__home_batch");
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/today-view.js");
    const { setSite } = await load("/src/db.js");
    await setSite("Test site", { siteId: "test-site", token: "test-token" });
    document.body.append(document.createElement("today-view"));
  });
  try {
    await expect.poll(() => batches.length).toBe(1);
    expect([...batches[0]].sort()).toEqual(["a", "b"]);
    const card = page.locator('.analysis-card[data-task-id="a"]');
    await expect(card).toBeVisible();
    const action = card.locator("button:visible").first();
    await action.focus();
    await expect(action).toBeFocused();
    await action.click({ trial: true });
  } finally {
    release();
  }
  await expect
    .poll(() =>
      page
        .locator("today-view")
        .evaluate(
          (view) =>
            /** @type {any} */ (view)._homeModel.tasks.filter(
              (/** @type {any} */ task) =>
                task.evidence?.text === "Synthetic note",
            ).length,
        ),
    )
    .toBe(2);
  expect(batches).toHaveLength(1);
});
