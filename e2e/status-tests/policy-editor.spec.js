import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";
import { initialPolicyDocument } from "../../backend/src/analysis/guidance/policy-import.js";
import {
  validatePolicy,
  compilePolicy,
} from "../../backend/src/analysis/guidance/policy-document.js";
import { evaluateCondition } from "../../backend/src/analysis/guidance/evaluator.js";

/** @type {WeakMap<import('@playwright/test').Page,string[]>} */
const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  page.on("pageerror", (error) => pageErrors.get(page)?.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

/** @param {import('@playwright/test').Page} page @param {boolean} [supervisor] */
async function setup(page, supervisor = true) {
  let document = initialPolicyDocument(),
    revision = 0;
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    let json = {};
    if (path.endsWith("/session"))
      json = {
        role: supervisor ? "compliance-supervisor" : "compliance-manager",
        capabilities: {
          managePolicies: supervisor,
          manageAdminUsers: supervisor,
          createEntities: supervisor,
        },
      };
    else if (path.endsWith("/policy/draft")) {
      if (route.request().method() === "PUT") {
        document = body.document;
        revision++;
      }
      json = {
        draft: { document, revision },
        activeVersion: document.baseVersion,
        activationAvailable: false,
      };
    } else if (path.endsWith("/policy/releases")) json = { releases: [] };
    else if (path.endsWith("/policy/validate"))
      json = validatePolicy(body.document, { translations: body.translations });
    else if (path.endsWith("/policy/preview"))
      json = {
        result: evaluateCondition({
          condition: {
            category: body.scenario.category,
            severity: body.scenario.severity,
          },
          answers: body.scenario.answers,
          reportedAt: body.scenario.reportedAt,
          catalog: compilePolicy(body.document),
        }),
      };
    else if (path.endsWith("/providers")) json = { providers: [] };
    else if (path.endsWith("/sites")) json = { sites: [] };
    else if (path.endsWith("/programs")) json = { programs: [] };
    else if (path.endsWith("/program-managers")) json = { programManagers: [] };
    await route.fulfill({ json });
  });
  await page.goto("/policies");
}

test("category and rule tables lead to stacked saved edits", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("#policy-categories-table tbody tr")).toHaveCount(
    14,
  );
  await page.locator('[data-edit-category="litter"]').click();
  await expect(page.locator("#policy-categories-table")).toHaveCount(0);
  const name = page.locator('[data-path="categories/0/name"] input');
  await name.fill("Example category name");
  const saved = page.waitForRequest(
    (r) => r.url().endsWith("/policy/draft") && r.method() === "PUT",
  );
  await page.locator("#policy-save").click();
  expect((await saved).postDataJSON().document.categories[0].name).toBe(
    "Example category name",
  );
  await expect(page.locator("#policy-categories-table")).toContainText(
    "Example category name",
  );
  await page.locator('[data-category-rules="litter"]').click();
  await expect(page.locator("#policy-rules-table tbody tr")).toHaveCount(2);
  await page.locator('[data-edit-rule="LITTER-1"]').click();
  await expect(page.locator('[data-path="rules/0/label"]')).toBeVisible();
  await page.locator("#policy-cancel").click();
  await expect(page.locator("#policy-rules-table")).toBeVisible();
  await page.locator("#policy-preview").click();
  await expect(
    page.getByRole("heading", { name: t("admin.policy.result.outcome") }),
  ).toBeVisible();
  await page.locator("#policy-back").click();
  await page.locator("#policy-validate").click();
  await expect(
    page.getByRole("heading", { name: t("admin.policy.problems") }),
  ).toBeVisible();
  await expect(page.locator("#policy-release")).toBeDisabled();
});

test("Cancel and Back guard edits and restore shared question changes", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-category-rules="bulky-items"]').click();
  await page.locator('[data-edit-rule="BULKY-1"]').click();
  const prompt = page.locator('[data-path$="/prompt"] textarea');
  const before = await prompt.inputValue();
  await prompt.fill("Synthetic changed question?");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#policy-back").click();
  await expect(prompt).toHaveValue("Synthetic changed question?");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#policy-cancel").click();
  await expect(page.locator("#policy-rules-table")).toBeVisible();
  await page.locator('[data-edit-rule="BULKY-1"]').click();
  await expect(page.locator('[data-path$="/prompt"] textarea')).toHaveValue(
    before,
  );
});

test("new category and rule cancellation leaves no phantom records", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#policy-add-category").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#policy-cancel").click();
  await expect(page.locator("#policy-categories-table tbody tr")).toHaveCount(
    14,
  );
  await page.locator('[data-category-rules="litter"]').click();
  await page.locator("#policy-add-rule").click();
  await page.locator("#policy-add-question").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#policy-cancel").click();
  await expect(page.locator("#policy-rules-table tbody tr")).toHaveCount(2);
});

test("failed save retains the edit and does not return to the table", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/admin/v1/policy/draft", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 409,
          json: { error: "policy_revision_conflict" },
        })
      : route.fallback(),
  );
  await page.locator('[data-edit-category="litter"]').click();
  await page
    .locator('[data-path="categories/0/name"] input')
    .fill("Example unsaved name");
  await page.locator("#policy-save").click();
  await expect(page.getByRole("alert")).toContainText(
    t("admin.policy.conflict"),
  );
  await expect(
    page.locator('[data-path="categories/0/name"] input'),
  ).toHaveValue("Example unsaved name");
  await expect(page.locator("#policy-categories-table")).toHaveCount(0);
});

test("manager cannot open the editor", async ({ page }) => {
  await setup(page, false);
  await expect(page).toHaveURL(/\/sites/);
  await expect(page.locator("policy-editor")).toHaveCount(0);
});

test("every field has keyboard-operable plain-language help and accessible forms", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-edit-category="litter"]').click();
  const field = page
    .locator(".policy-field")
    .filter({ has: page.locator('[data-path="categories/0/definition"]') });
  const help = field.locator("button[data-help]");
  await help.focus();
  await page.keyboard.press("Enter");
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await expect(field.locator(".policy-field-description")).toBeVisible();
  await expect(field.locator(".policy-field-description")).toHaveText(
    t("admin.policy.help.definition"),
  );
  await page.keyboard.press("Enter");
  await expect(field.locator(".policy-field-description")).toBeHidden();
  await help.click();
  const categoryResults = await new AxeBuilder({ page })
    .include("policy-editor")
    .analyze();
  expect(
    categoryResults.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ),
  ).toEqual([]);
  await page.locator("#policy-cancel").click();
  await page.locator('[data-category-rules="litter"]').click();
  await page.locator('[data-edit-rule="LITTER-1"]').click();
  await expect(page.locator(".policy-field")).toHaveCount(
    await page
      .locator(
        "policy-editor wa-input,policy-editor wa-select,policy-editor wa-textarea,policy-editor wa-checkbox",
      )
      .count(),
  );
  const ruleResults = await new AxeBuilder({ page })
    .include("policy-editor")
    .analyze();
  expect(
    ruleResults.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ),
  ).toEqual([]);
  await page.screenshot({ path: "/tmp/gnp-policy-stacked-rule.png" });
});

test("new records save to their tables and browser Back protects an in-progress edit", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#policy-add-category").click();
  await page
    .locator('[data-path$="/name"] input')
    .fill("Synthetic new category");
  await page.locator("#policy-save").click();
  const row = page
    .locator("#policy-categories-table tr")
    .filter({ hasText: "Synthetic new category" });
  await expect(row).toBeVisible();
  await row.locator("[data-category-rules]").click();
  await page.locator("#policy-add-rule").click();
  await page
    .locator('[data-path$="/label"] textarea')
    .fill("Synthetic new instruction");
  await page.locator("#policy-save").click();
  await expect(page.locator("#policy-rules-table")).toContainText(
    "Synthetic new instruction",
  );
  await page.locator("#policy-back").click();
  await page.evaluate(() => history.pushState({}, "", "/policies?testBack=1"));
  await row.locator("[data-edit-category]").click();
  await page
    .locator('[data-path$="/name"] input')
    .fill("Synthetic unsaved edit");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(page.locator('[data-path$="/name"] input')).toHaveValue(
    "Synthetic unsaved edit",
  );
});
