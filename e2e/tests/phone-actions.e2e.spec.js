// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";
import { activeCatalog } from "../../backend/src/analysis/guidance/catalog-registry.js";

/**
 * Capture only the native-app handoff. Keep the production click handlers,
 * viewport gate, number formatting, and completion flow intact. Never dial a
 * real agency (including 911) from an automated browser.
 * @param {import('@playwright/test').Page} page
 */
async function capturePhoneHandoffs(page) {
  /** @type {string[]} */
  const calls = [];
  await page.exposeFunction("recordPhoneHandoff", (/** @type {string} */ url) =>
    calls.push(url),
  );
  await page.route(
    "**/src/components/analysis-card-completion.js",
    async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const assignment = "window.location.href = ";
      expect(source.split(assignment)).toHaveLength(2);
      await route.fulfill({
        response,
        body: source.replace(
          /window\.location\.href = ([^;]+);/,
          "void window.recordPhoneHandoff($1);",
        ),
      });
    },
  );
  return calls;
}

/** Stateful API fixture; reloads read the saved status, not a UI override.
 * @param {import('@playwright/test').Page} page
 * @param {string} ruleId
 */
async function issueFixture(page, ruleId) {
  const rule = activeCatalog().rules.find(
    (candidate) => candidate.ruleId === ruleId,
  );
  if (!rule) throw new Error(`Missing rule ${ruleId}`);
  // Keep the task inside Today's 14-day active window on every test run.
  const createdAt = Date.now() - 5 * 60 * 1000;
  let task = {
    ...rule.outcome,
    taskId: `phone-test-${ruleId}`,
    checkId: "phone-test-check",
    ruleId,
    policyVersion: activeCatalog().policyVersion,
    category: rule.category,
    canBeInProgress: rule.canBeInProgress,
    primaryInProgressAgency: rule.primaryInProgressAgency,
    status: "open",
    createdAt: new Date(createdAt).toISOString(),
    inProgressAt: "",
  };
  /** @type {Array<{completionMethod: string}>} */
  const completions = [];
  const state = {
    fail: false,
    hold: Promise.resolve(),
    completions,
    label: rule.outcome.buttons[0],
  };
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({ json: { tasks: [task] } }),
  );
  await page.route("**/v1/checks?*", (route) =>
    route.fulfill({ json: { checks: [] } }),
  );
  await page.route(`**/v1/tasks/${task.taskId}/complete`, async (route) => {
    completions.push(route.request().postDataJSON());
    await state.hold;
    if (state.fail) {
      await route.fulfill({
        status: 500,
        json: { error: "test-save-failure" },
      });
      return;
    }
    task = {
      ...task,
      status: "in_progress",
      inProgressAt: new Date().toISOString(),
    };
    await route.fulfill({ json: { task } });
  });
  await page.goto("/today?filter=todo");
  return {
    state,
    card: page.locator(`[data-task-id="${task.taskId}"]`),
  };
}

for (const [ruleId, number] of [
  ["THREAT-1", "4155530123"],
  ["FIRE-4", "911"],
  ["PARKING-1", "311"],
]) {
  test(`mobile ${ruleId}: keyboard CTA hands off the rubric number and saves In progress`, async ({
    page,
  }) => {
    const calls = await capturePhoneHandoffs(page);
    await page.setViewportSize({ width: 520, height: 900 });
    const { card, state } = await issueFixture(page, ruleId);
    const button = card.locator("[data-phone-number]");
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName(state.label);
    await expect(card.getByRole("checkbox")).toBeHidden();
    await expect(card.locator('[data-action^="cant"]')).toHaveCount(0);
    let release = () => {};
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await button.focus();
      // A late list/evidence response can repaint Home between focus and Enter.
      await page.locator("today-view").evaluate((element) => {
        const view = /** @type {any} */ (element);
        view._renderHome({
          ...view._homeModel,
          tasks: view._homeModel.tasks.map((/** @type {any} */ task) => ({
            ...task,
            description: "Updated synthetic issue description",
          })),
        });
      });
      await expect(button).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => calls).toEqual([`tel:${number}`]);
      await expect
        .poll(() => state.completions)
        .toEqual([{ completionMethod: "manual" }]);
      await expect(card).toBeVisible();
      await expect(button).toBeDisabled();
    } finally {
      release();
    }
    await expect(card).toHaveCount(0);
    await page.goto("/today?filter=in_progress");
    await expect(card).toBeVisible();
    await expect(card.locator("[data-phone-number]")).toHaveCount(0);
    await expect(card.locator('[data-action="update"]')).toBeVisible();
    await page.reload();
    await expect(card).toBeVisible();
    expect(calls).toEqual([`tel:${number}`]);
    expect(state.completions).toHaveLength(1);
  });
}

test("phone controls switch at 520px without reload; desktop checkbox never dials", async ({
  page,
}) => {
  const calls = await capturePhoneHandoffs(page);
  await page.setViewportSize({ width: 521, height: 900 });
  const { card, state } = await issueFixture(page, "THREAT-1");
  const checkbox = card.getByRole("checkbox");
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toHaveAccessibleName(state.label);
  await expect(card.locator("[data-phone-number]")).toBeHidden();
  await page.setViewportSize({ width: 520, height: 900 });
  await expect(checkbox).toBeHidden();
  await expect(card.locator("[data-phone-number]")).toBeVisible();
  await page.setViewportSize({ width: 521, height: 900 });
  await expect(checkbox).toBeVisible();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect.poll(() => state.completions.length).toBe(1);
  await expect(card).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("failed mobile save offers a save-only retry", async ({ page }) => {
  const calls = await capturePhoneHandoffs(page);
  await page.setViewportSize({ width: 390, height: 850 });
  const { card, state } = await issueFixture(page, "THREAT-1");
  state.fail = true;
  const button = card.locator("[data-phone-number]");
  await button.click();
  await expect(
    page.getByText(t("toast.actionSaveError.message"), { exact: true }),
  ).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(card).toBeVisible();
  expect(calls).toEqual(["tel:4155530123"]);
  state.fail = false;
  await page
    .getByRole("button", { name: t("common.retry"), exact: true })
    .click();
  await expect(card).toHaveCount(0);
  expect(state.completions).toHaveLength(2);
  expect(calls).toEqual(["tel:4155530123"]);
});

test("mobile Recology pickup action uses its rubric phone number and 311 ticket stays a manual filing CTA", async ({
  page,
}) => {
  const calls = await capturePhoneHandoffs(page);
  await page.setViewportSize({ width: 390, height: 850 });
  const { card } = await issueFixture(page, "BULKY-1");
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.locator("[data-phone-number]")).toBeVisible();
  await expect(card.locator("[data-phone-number]")).toHaveAttribute(
    "data-phone-number",
    "415-330-1400",
  );
  const ticket = await issueFixture(page, "LITTER-2");
  await expect(ticket.card.locator('[data-action="file311"]')).toBeVisible();
  await expect(ticket.card.getByRole("checkbox")).toHaveCount(0);
  await expect(ticket.card.locator("[data-phone-number]")).toHaveCount(0);
  expect(ticket.state.completions).toEqual([]);
  expect(calls).toEqual([]);
});

test("phone save survives reload during preparation without redialing", async ({
  page,
}) => {
  const calls = await capturePhoneHandoffs(page);
  await page.setViewportSize({ width: 520, height: 900 });
  // Suspend request preparation, before fetch, on the first page only.
  await page.route("**/src/services/phone-completion.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "const result = await completeTask(",
        "await new Promise(() => {}); const result = await completeTask(",
      ),
    });
  });
  const { card, state } = await issueFixture(page, "THREAT-1");
  await card.locator("[data-phone-number]").click();
  await expect.poll(() => calls).toEqual(["tel:4155530123"]);
  expect(state.completions).toHaveLength(0);
  expect(
    await page.evaluate(() =>
      Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith("gnp:phone-completion:"),
      ),
    ),
  ).toHaveLength(1);
  await page.unroute("**/src/services/phone-completion.js");
  await page.reload();
  await expect.poll(() => state.completions.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(window.sessionStorage).filter((key) =>
            key.startsWith("gnp:phone-completion:"),
          ).length,
      ),
    )
    .toBe(0);
  expect(calls).toEqual(["tel:4155530123"]);
});
