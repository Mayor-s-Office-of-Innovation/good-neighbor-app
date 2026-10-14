// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
async function stubEmptyComplaints(page) {
  await page.route("**/v1/complaints", (route) =>
    route.fulfill({ json: { complaints: [] } }),
  );
}

/** @param {import("@playwright/test").Locator} icon */
async function expectRenderedIcon(icon) {
  await expect(icon).toBeVisible();
  await expect
    .poll(() =>
      icon.evaluate((element) =>
        Boolean(element.shadowRoot?.querySelector("svg")),
      ),
    )
    .toBe(true);
}

test.describe("public complaints", () => {
  test("home overflow is circular, icon-labeled, left-aligned, and keyboard operable", async ({
    page,
  }) => {
    const trigger = page.locator("#home-action-menu-trigger");
    const menu = page.locator("#home-action-menu");

    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();

    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox?.width).toBe(54);
    expect(triggerBox?.height).toBe(54);
    expect(
      await trigger.evaluate(
        (element) => window.getComputedStyle(element).borderRadius,
      ),
    ).toBe("50%");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();

    const complaintAction = page.locator("#view-complaints");
    const issueAction = page.locator("#report-problem");
    await expect(complaintAction).toHaveText(t("today.actions.complaints"));
    await expect(issueAction).toHaveText(t("today.actions.report"));
    await expect(menu.getByRole("menuitem")).toHaveCount(2);

    const complaintIcon = complaintAction.locator('wa-icon[name="bullhorn"]');
    const issueIcon = issueAction.locator('wa-icon[name="flag"]');
    await expectRenderedIcon(complaintIcon);
    await expectRenderedIcon(issueIcon);

    for (const [button, icon] of [
      [complaintAction, complaintIcon],
      [issueAction, issueIcon],
    ]) {
      const buttonBox = await button.boundingBox();
      const iconBox = await icon.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(iconBox).not.toBeNull();
      expect((iconBox?.x ?? 0) - (buttonBox?.x ?? 0)).toBeLessThan(20);
      expect(
        await button.evaluate(
          (element) => window.getComputedStyle(element).justifyContent,
        ),
      ).toBe("flex-start");
    }

    await expect(complaintAction).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(issueAction).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("opens the complaint list and reveals the description field inline", async ({
    page,
  }) => {
    await stubEmptyComplaints(page);
    await page.locator("#home-action-menu-trigger").click();
    await page.locator("#view-complaints").click();

    await expect(page).toHaveURL(/\/complaints$/);
    await expect(page.getByRole("heading", { name: t("complaints.title") })).toBeVisible();

    const back = page.locator(".complaints .topbar__back");
    await expect(back).toHaveAccessibleName(t("common.back"));
    await expect(page.locator(".complaints__back-icon")).toHaveCSS(
      "mask-image",
      /chevron-left\.svg/,
    );

    const logButton = page.locator("#log-complaint");
    const empty = page.locator(".complaints__empty");
    await expect(empty).toHaveText(t("complaints.empty"));
    await expect(empty).toHaveCSS("text-align", "center");
    const logBox = await logButton.boundingBox();
    const emptyBox = await empty.boundingBox();
    expect(logBox).not.toBeNull();
    expect(emptyBox).not.toBeNull();
    expect(Math.round((emptyBox?.y ?? 0) - ((logBox?.y ?? 0) + (logBox?.height ?? 0)))).toBe(
      18,
    );

    await logButton.click();
    await expect(page).toHaveURL(/\/complaints\/new$/);
    await expect(page.getByRole("heading", { name: t("complaints.compose.title") })).toBeVisible();
    await expect(page.locator(".complaint-compose [data-back]")).toHaveCount(0);
    await expect(page.locator("#close-complaint")).toHaveAccessibleName(t("common.close"));
    await expect(page.locator(".complaint-upload-copy")).toContainText(
      t("complaints.upload.title"),
    );
    await expect(page.locator("#complaint-files")).toHaveAttribute(
      "accept",
      ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.txt,.doc,.docx",
    );

    const submit = page.locator("#submit-complaint");
    await expect(submit).toBeDisabled();
    await page.locator("#describe-complaint").click();
    await expect(page).toHaveURL(/\/complaints\/new$/);
    await expect(page.locator("#describe-complaint")).toHaveCount(0);

    const description = page.locator("#complaint-description");
    await expect(description).toBeVisible();
    await expect(description).toBeFocused();
    await expect(description).toHaveAttribute("maxlength", "4000");
    await expect(description).toHaveAttribute(
      "placeholder",
      t("complaints.describe.placeholder"),
    );

    await description.fill("Four");
    await expect(submit).toBeDisabled();
    await description.fill("Five!");
    await expect(submit).toBeEnabled();

    await page.locator("#close-complaint").click();
    await expect(page).toHaveURL(/\/complaints$/);
    await expect(empty).toBeVisible();
  });
});
