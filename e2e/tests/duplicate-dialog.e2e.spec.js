// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test("duplicate custom element preserves keyboard focus, history, and flag cleanup", async ({
  page,
}) => {
  await bindSite(page);
  // This component test opens the dialog programmatically. Keep its trigger
  // outside home's asynchronously replaced worklist, just like the dialog.
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "duplicate-dialog-trigger";
    button.textContent = "Open duplicate fixture";
    document.body.append(button);
  });
  const trigger = page.locator("#duplicate-dialog-trigger");
  await trigger.focus();
  const open = async () =>
    page.evaluate(async () => {
      const flagModule = "/src/services/feature-flags.js";
      const dialogModule = "/src/components/duplicate-issue-dialog.js";
      const { setDuplicateUiSite } = await import(flagModule);
      const { openDuplicateIssue } = await import(dialogModule);
      setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
      openDuplicateIssue(
        {
          taskId: "dialog-test",
          createdAt: "2026-10-15T12:00:00Z",
          userFriendlyLabel: "Dialog fixture",
          duplicate: {
            sourceRevision: "r1",
            original: {
              taskId: "original",
              status: "open",
              createdAt: "2026-10-14T12:00:00Z",
            },
          },
        },
        document.querySelector("#duplicate-dialog-trigger"),
        {
          onSeparated: () => {},
          onOriginal: () => {},
        },
      );
    });
  await open();
  const host = page.locator("duplicate-issue-dialog");
  await expect(host.locator("dialog")).toBeVisible();
  await expect(page).toHaveURL(/#duplicate-dialog-test$/);
  await page.keyboard.press("Escape");
  await expect(host).toHaveCount(0);
  await expect(page).toHaveURL(/\/today(?:\?[^#]*)?$/);
  await expect(trigger).toBeFocused();
  await open();
  await expect(host.locator("dialog")).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/services/feature-flags.js";
    (await import(module)).setDuplicateUiSite(null);
  });
  await expect(host).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
