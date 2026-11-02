import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const kind of ["single", "duplicate", "group"]) {
  test(`deletion confirmation: ${kind} scope is keyboard accessible`, async ({
    page,
    browserName,
  }) => {
    await page.route("**/v1/**", (route) =>
      route.fulfill({
        json: {
          deletion: {
            kind,
            targets: [
              {
                taskId: "root",
                checkId: "check",
                artifactId: "artifact",
                conditionId: "condition",
              },
            ],
          },
        },
      }),
    );
    await page.route("**/__deletion_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><title>Deletion test</title></head><body><main></main></body></html>',
      }),
    );
    await page.goto("/__deletion_test");
    const expected = await page.evaluate(async (kind) => {
      const load = (/** @type {string} */ path) => import(path);
      await load("/src/styles/tokens.css");
      await load("/src/styles/base.css");
      const { setSite } = await load("/src/db.js");
      await setSite("Synthetic deletion test", {
        siteId: "test-site",
        token: "test-token",
      });
      const { analysisDialogs } = await load(
        "/src/components/analysis-results.templates.js",
      );
      const { prepareCardDeletion } = await load(
        "/src/components/analysis-card-deletion.js",
      );
      const { t } = await load("/src/i18n/i18n.js");
      const host = /** @type {any} */ (document.createElement("div"));
      host.innerHTML = analysisDialogs();
      document.querySelector("main")?.append(host);
      host._activeProblem = { taskId: "root" };
      host.querySelector("#analysis-delete-title").textContent = t(
        "analysis.deleteDialog.titleFor",
        { title: "Synthetic issue" },
      );
      const ready = prepareCardDeletion(host, host._activeProblem);
      host.querySelector("#analysis-delete-dialog").showModal();
      await ready;
      return t(`analysis.deleteDialog.${kind === "single" ? "text" : kind}`, {
        count: 1,
      });
    }, kind);
    await expect(page.locator("#analysis-delete-copy")).toHaveText(expected);
    const confirm = page.locator("#analysis-delete-confirm");
    await expect(confirm).toBeEnabled();
    // Native focus stays on Cancel while loading. Shift+Tab reaches Delete
    // once the confirmed scope enables it, with the existing focus ring.
    await page.locator("#analysis-delete-dialog button[type=submit]").focus();
    await page.keyboard.press(
      browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab",
    );
    await expect(confirm).toBeFocused();
    await expect(confirm).toHaveCSS("outline-style", "solid");
    const audit = await new AxeBuilder({ page })
      .include("#analysis-delete-dialog")
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#analysis-delete-dialog")).not.toBeVisible();
  });
}
