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
      if (kind === "single") {
        // Exercise the audit's settle guard with a deliberately slow entrance.
        const style = document.createElement("style");
        style.textContent =
          "dialog, dialog::backdrop { transition-duration: 1s; }";
        document.head.append(style);
      }
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
    // Visibility and keyboard focus can settle before the opacity transition.
    await expect(page.locator("#analysis-delete-dialog")).toHaveCSS(
      "opacity",
      "1",
    );
    const audit = await new AxeBuilder({ page })
      .include("#analysis-delete-dialog")
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#analysis-delete-dialog")).not.toBeVisible();
  });
}

for (const code of [
  "matching_pending",
  "matching_unavailable",
  "group_changed",
  "group_too_large",
  "server_error",
  "already_deleted",
  "verified_group",
]) {
  test(`selected-card deletion remains available when group scope fails: ${code}`, async ({
    page,
  }) => {
    const writes = /** @type {any[]} */ ([]);
    await page.route("**/v1/**", async (route) => {
      if (route.request().method() === "POST") {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ json: { deleted: [{ taskId: "root" }] } });
      }
      if (code === "already_deleted")
        return route.fulfill({
          status: 409,
          json: { code, error: "Already deleted" },
        });
      if (
        code === "verified_group" &&
        new URL(route.request().url()).searchParams.get("view") !== "selected"
      )
        return route.fulfill({
          json: {
            deletion: {
              kind: "group",
              targets: [{ taskId: "root" }, { taskId: "sibling" }],
            },
          },
        });
      if (
        new URL(route.request().url()).searchParams.get("view") === "selected"
      )
        return route.fulfill({
          json: {
            deletion: {
              kind: "single",
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
        });
      return route.fulfill({
        status: code === "server_error" ? 500 : 409,
        json: { code, error: "Synthetic group validation failure" },
      });
    });
    await page.route("**/__selected_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><title>Selected deletion</title></head><body><main></main></body></html>',
      }),
    );
    await page.goto("/__selected_test");
    await page.evaluate(async () => {
      const load = (/** @type {string} */ path) => import(path);
      await load("/src/styles/tokens.css");
      await load("/src/styles/base.css");
      const { setSite } = await load("/src/db.js");
      await setSite("Synthetic site", {
        siteId: "site",
        token: "synthetic-token",
      });
      const { analysisDialogs } = await load(
        "/src/components/analysis-results.templates.js",
      );
      const { prepareCardDeletion } = await load(
        "/src/components/analysis-card-deletion.js",
      );
      const { rejectProblemCondition } = await load(
        "/src/components/analysis-problem-actions.js",
      );
      const host = /** @type {any} */ (document.createElement("div"));
      host.innerHTML = analysisDialogs();
      document.querySelector("main")?.append(host);
      const { t } = await load("/src/i18n/i18n.js");
      host.querySelector("#analysis-delete-title").textContent = t(
        "analysis.deleteDialog.titleFor",
        { title: "Synthetic issue" },
      );
      host._activeProblem = {
        taskId: "root",
        checkId: "check",
        artifactId: "artifact",
        conditionId: "condition",
      };
      host.querySelector("#analysis-delete-confirm").addEventListener(
        "click",
        () =>
          void rejectProblemCondition(host._activeProblem, {
            requestId: "synthetic-delete",
            deleteLocally: () => {},
            onRefreshFailure: () => {},
          }),
      );
      host.querySelector("#analysis-delete-dialog").showModal();
      await prepareCardDeletion(host, host._activeProblem);
    });
    const confirm = page.locator("#analysis-delete-confirm");
    if (code === "already_deleted") {
      await expect(confirm).toBeDisabled();
      await expect(page.locator("[data-delete-selected]")).toHaveText(
        await page.evaluate(async () => {
          const path = "/src/i18n/i18n.js";
          return (await import(path)).t("analysis.deleteDialog.refresh");
        }),
      );
      expect(writes).toHaveLength(0);
      return;
    }
    if (code === "verified_group") await expect(confirm).toBeEnabled();
    else await expect(confirm).toBeDisabled();
    const fallback = page.locator("[data-delete-selected]");
    await expect(fallback).toBeEnabled();
    await fallback.focus();
    await page.keyboard.press("Enter");
    await expect(confirm).toBeFocused();
    await expect(confirm).toBeEnabled();
    await expect(page.locator("#analysis-delete-copy")).toHaveText(
      await page.evaluate(async () => {
        const path = "/src/i18n/i18n.js";
        return (await import(path)).t("analysis.deleteDialog.selectedText");
      }),
    );
    await expect(page.locator("#analysis-delete-dialog")).toHaveCSS(
      "opacity",
      "1",
    );
    expect(
      (
        await new AxeBuilder({ page })
          .include("#analysis-delete-dialog")
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(writes).toHaveLength(0);
    await confirm.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      taskId: "root",
      deletionMode: "selected",
      deletionTaskIds: ["root"],
    });
  });
}
