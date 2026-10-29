import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";

for (const screen of ["today-view", "perimeter-check", "problem-report"]) {
  for (const blockModule of [true, false]) {
    test(`${screen}: resolution saves (module blocked: ${blockModule})`, async ({
      page,
    }) => {
      let requests = 0;
      let release = () => {};
      const response = new Promise((resolve) => {
        release = () => resolve(null);
      });
      await page.route("**/v1/tasks/resolve-fixture/updates", async (route) => {
        requests++;
        expect(route.request().postDataJSON()).toEqual({
          type: "issue_resolved",
        });
        await response;
        await route.fulfill({
          json: {
            task: { taskId: "resolve-fixture", status: "completed" },
            update: { updateId: "saved" },
          },
        });
      });
      if (blockModule)
        await page.route("**/src/components/task-update-dialog.js*", (route) =>
          route.abort(),
        );
      await page.goto("/");
      await page.evaluate(async (screen) => {
        const load = (/** @type {string} */ path) => import(path);
        await load(`/src/components/${screen}.js`);
        const { TaskSheets } = await load("/src/components/task-sheets.js");
        const session = await load("/src/state/check-session.js");
        const { analysisCards, taskAnalysisCard } = await load(
          "/src/components/analysis-results.templates.js",
        );
        const { problemFromCard } = await load(
          "/src/components/analysis-problem-actions.js",
        );
        document.body.innerHTML =
          '<main id="fixture"></main><app-toasts></app-toasts>';
        const host = /** @type {any} */ (document.querySelector("#fixture"));
        const task = {
          taskId: "resolve-fixture",
          conditionId: "condition",
          status: "in_progress",
          kind: "action",
          category: "Litter",
          createdAt: new Date().toISOString(),
        };
        const check = session.startCheck("test");
        const item = session.addItem({
          kind: "text",
          text: "Test evidence",
          analysis: { status: "analyzed", tasks: [task] },
        });
        host.innerHTML =
          screen === "today-view"
            ? taskAnalysisCard({
                task,
                action: { kind: "update", label: "Updates" },
              })
            : analysisCards(item, check.id).join("");
        const proto = /** @type {any} */ (window.customElements.get(screen))
          .prototype;
        host._problemFromCard = problemFromCard;
        if (screen === "today-view") {
          const sheets = new TaskSheets({
            host,
            container: () => host,
            onTaskUpdated: () => (host.dataset.saved = "true"),
          });
          host._taskSheets = () => sheets;
          const card = host.querySelector(".analysis-card");
          const button = host.querySelector('[data-action="mark-resolved"]');
          button.addEventListener("click", () =>
            proto._onAction.call(host, card, task, button),
          );
        } else if (screen === "perimeter-check") {
          host.addEventListener("click", (/** @type {MouseEvent} */ event) =>
            proto._onAnalysisClick.call(host, event),
          );
        } else proto._wireAnalysisCards.call(host);
      }, screen);
      const button = page.locator(
        '#fixture [data-action="mark-resolved"], #fixture [data-analysis-action="mark-resolved"]',
      );
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveText(t("taskUpdate.resolving"));
      await expect(button).toBeDisabled();
      await expect.poll(() => requests).toBe(1);
      release();
      if (blockModule) {
        await expect(
          page.getByText(t("taskUpdate.formUnavailableResolved"), {
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: t("common.retry"), exact: true })
          .click();
        await expect(
          page.getByText(t("taskUpdate.formUnavailableResolved"), {
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(
          page.locator("task-update-dialog dialog[open]"),
        ).toBeVisible();
        await expect(page.locator(".app-toast--success")).toHaveCount(0);
      }

      expect(requests).toBe(1);
    });
  }
}
