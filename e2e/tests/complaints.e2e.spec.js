// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
async function stubEmptyComplaints(page) {
  await page.route("**/v1/complaints", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { complaints: [] } });
  });
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

    // Background home refreshes can replace nodes between visibility and layout
    // reads. Retry measurements against the current DOM without relaxing size.
    await expect
      .poll(() => trigger.boundingBox())
      .toMatchObject({ width: 54, height: 54 });
    // Check each corner directly: Chromium can serialize the computed
    // border-radius shorthand as an empty string on some platforms.
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-right",
      "bottom-left",
    ]) {
      await expect(trigger).toHaveCSS(`border-${corner}-radius`, "50%");
    }

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();

    const complaintAction = page.locator("#view-complaints");
    const issueAction = page.locator("#report-problem");
    await expect(complaintAction).toHaveText(t("today.actions.complaints"));
    await expect(issueAction).toHaveText(t("today.actions.report"));
    await expect(menu.getByRole("menuitem")).toHaveCount(3);

    const complaintIcon = complaintAction.locator('wa-icon[name="bullhorn"]');
    const issueIcon = issueAction.locator('wa-icon[name="flag"]');
    await expectRenderedIcon(complaintIcon);
    await expectRenderedIcon(issueIcon);

    for (const [button, icon] of [
      [complaintAction, complaintIcon],
      [issueAction, issueIcon],
    ]) {
      await expect
        .poll(async () => {
          const buttonBox = await button.boundingBox();
          const iconBox = await icon.boundingBox();
          return buttonBox && iconBox ? iconBox.x - buttonBox.x : null;
        })
        .toBeLessThan(20);
      await expect(button).toHaveCSS("justify-content", "flex-start");
    }

    await expect(issueAction).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(complaintAction).toBeFocused();
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
    await expect(
      page.getByRole("heading", { name: t("complaints.title") }),
    ).toBeVisible();

    const back = page.locator(".complaints .care-back");
    await expect(back).toHaveAccessibleName(t("common.close"));
    await expect(back.locator('wa-icon[name="xmark"]')).toBeVisible();

    const logButton = page.locator("#log-complaint");
    const empty = page.locator(".complaints__empty");
    await expect(empty).toHaveText(t("complaints.empty"));
    await expect(empty).toHaveCSS("text-align", "center");
    const logBox = await logButton.boundingBox();
    const emptyBox = await empty.boundingBox();
    expect(logBox).not.toBeNull();
    expect(emptyBox).not.toBeNull();
    expect(
      Math.round(
        (emptyBox?.y ?? 0) - ((logBox?.y ?? 0) + (logBox?.height ?? 0)),
      ),
    ).toBe(18);

    await logButton.click();
    await expect(page).toHaveURL(/\/complaints\/new$/);
    await expect(
      page.getByRole("heading", { name: t("complaints.compose.title") }),
    ).toBeVisible();
    await expect(page.locator(".complaint-compose [data-back]")).toHaveCount(0);
    await expect(page.locator("#close-complaint")).toHaveAccessibleName(
      t("common.back"),
    );
    await expect(page.locator(".complaint-upload-copy")).toContainText(
      t("complaints.upload.title"),
    );
    await expect(page.locator("#complaint-files")).toHaveAttribute(
      "accept",
      ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.txt",
    );

    const submit = page.locator("#submit-complaint");
    await expect(submit).toBeDisabled();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      document.documentElement.dataset.complaintScrollBehavior = "";
      window.HTMLElement.prototype.scrollIntoView = function (
        /** @type {ScrollIntoViewOptions | undefined} */ options,
      ) {
        document.documentElement.dataset.complaintScrollBehavior =
          options?.behavior || "";
      };
    });
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
    await expect(page.locator("html")).toHaveAttribute(
      "data-complaint-scroll-behavior",
      "auto",
    );

    await description.fill("Four");
    await expect(submit).toBeDisabled();
    await description.fill("Five!");
    await expect(submit).toBeEnabled();

    await page.route("**/v1/complaints", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({
        status: 503,
        json: { error: "unavailable" },
      });
    });
    await submit.click();
    await expect(
      page.locator("complaint-view").getByRole("alert"),
    ).toContainText(t("complaints.submitError"));
    await expect(submit).toBeEnabled();
    await expect(description).toHaveValue("Five!");

    await page.locator("#close-complaint").click();
    await expect(page).toHaveURL(/\/complaints$/);
    await expect(empty).toBeVisible();

    await logButton.click();
    await page.locator("#describe-complaint").click();
    await description.fill("Synthetic complaint for navigation regression");
    await page.route("**/v1/complaints", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: { complaintId: "synthetic" } })
        : route.fallback(),
    );
    await submit.click();
    await expect(page).toHaveURL(/\/complaints$/);
    await back.click();
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
  });

  test("uses native detail links and renders a recoverable missing-detail state", async ({
    page,
  }) => {
    await page.route("**/v1/complaints**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/v1/complaints") {
        return route.fulfill({
          json: {
            complaints: [
              {
                complaintId: "11111111-1111-4111-8111-111111111111",
                label: "Noise near the entrance",
                status: "ready",
                createdAt: "2026-10-14T12:00:00.000Z",
              },
            ],
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: "complaint_not_found" },
      });
    });
    await page.locator("#home-action-menu-trigger").click();
    await page.locator("#view-complaints").click();

    const link = page.locator(
      '[data-complaint-link="11111111-1111-4111-8111-111111111111"]',
    );
    await expect(link).toHaveAttribute(
      "href",
      "/complaints/11111111-1111-4111-8111-111111111111",
    );
    expect(await link.evaluate((element) => element.tagName)).toBe("A");

    await link.click();
    await expect(
      page.locator("complaint-view").getByRole("alert"),
    ).toContainText(t("complaints.detailError"));
    await expect(page.locator(".complaints .topbar__back")).toBeVisible();
  });
});
