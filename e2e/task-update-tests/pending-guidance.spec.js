import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";

const assessment = { assessmentId: "old-assessment", checkId: "old-check" };
const question = {
  conditionId: "bulky",
  canonicalCategory: "Bulky items",
  status: "needs_answer",
  description: "Abandoned furniture on the sidewalk.",
  createdAt: new Date(Date.now() - 86400000).toISOString(),
  source: { artifactIds: ["text-artifact"] },
  needsAnswer: {
    key: "provider_generated",
    prompt: "Are these items from your site?",
    options: [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ],
  },
};
const task = {
  taskId: "bulky-task",
  assessmentId: assessment.assessmentId,
  conditionId: question.conditionId,
  checkId: "old-check",
  category: "Bulky items",
  severity: 2,
  kind: "escalation",
  status: "open",
  buttons: ["File 311 ticket"],
  guidance: "Report it to the City.",
  createdAt: question.createdAt,
  updatedAt: question.createdAt,
};

for (const resolution of ["answer", "dismiss"])
  test(`recovered questions survive outages and expired edits, then ${resolution}`, async ({
    page,
  }) => {
    let answered = false;
    let answers = 0;
    let guidanceFailed = false;
    let dismissals = 0;
    const liveTask = {
      ...task,
      taskId: "live-task",
      conditionId: "live-condition",
      checkId: "newer-check",
      createdAt: new Date().toISOString(),
    };
    await page.route("**/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/reject")) {
        answered = true;
        dismissals++;
        return route.fulfill({ json: { dismissed_locally: true } });
      }
      if (url.pathname.endsWith("/answers")) {
        expect(route.request().postDataJSON()).toEqual({
          answers: { provider_generated: false },
        });
        answered = true;
        answers++;
        return route.fulfill({
          json: {
            assessmentItem: assessment,
            conditionItem: {
              ...question,
              status: "tasks_created",
              needsAnswer: null,
            },
            taskItem: task,
          },
        });
      }
      if (
        url.pathname ===
        "/v1/checks/old-check/artifacts/text-artifact/conditions/bulky"
      )
        return route.fulfill({
          status: 404,
          json: {
            code: "unknown_analysis",
            error: "Original analysis unavailable",
          },
        });
      if (
        [
          "/v1/guidance/pending",
          "/v1/assessments/old-assessment/guidance",
        ].includes(url.pathname) &&
        guidanceFailed
      )
        return route.fulfill({
          status: 503,
          json: { error: "Guidance temporarily unavailable" },
        });
      if (url.pathname === "/v1/assessments/old-assessment/guidance")
        return route.fulfill({
          json: {
            assessment,
            conditions: answered ? [] : [question],
            tasks: answers ? [task] : [],
          },
        });
      if (url.pathname === "/v1/guidance/pending")
        return route.fulfill({
          json: url.searchParams.has("nextToken")
            ? {
                guidance: answered
                  ? []
                  : [{ assessment, conditions: [question] }],
                nextToken: null,
              }
            : { guidance: [], nextToken: "second-page" },
        });
      if (url.pathname === "/v1/tasks")
        return route.fulfill({
          json: {
            tasks:
              url.searchParams.get("status") === "open"
                ? [liveTask, ...(answers ? [task] : [])]
                : [],
          },
        });
      if (url.pathname === "/v1/checks")
        return route.fulfill({
          json: {
            checks: [
              {
                checkId: "newer-check",
                status: "completed",
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                issueCount: 0,
              },
            ],
          },
        });
      return route.fulfill({ json: { sites: [], artifacts: [], updates: [] } });
    });
    await page.route("**/__pending_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><title>Pending questions</title></head><body><script type="module" src="/src/main.js"></script></body></html>',
      }),
    );
    const mount = async () =>
      page.evaluate(async () => {
        const load = (/** @type {string} */ path) => import(path);
        await load("/src/components/today-view.js");
        const { setSite } = await load("/src/db.js");
        await setSite("Test site", {
          siteId: "test-site",
          token: "test-token",
        });
        await load("/src/components/app-toasts.js");
        document.body.append(document.createElement("app-toasts"));
        document.body.append(document.createElement("today-view"));
      });
    await page.goto("/__pending_test");
    if (resolution === "dismiss")
      await page.evaluate(
        async ({ assessment, question }) => {
          const path = "/src/db.js";
          const { setSite, saveFinishedCheck } = await import(path);
          await setSite("Test site", {
            siteId: "test-site",
            token: "test-token",
          });
          await saveFinishedCheck({
            siteId: "test-site",
            id: "old-check",
            status: "capture-complete",
            scorecardDone: true,
            items: [
              {
                id: "retained-local",
                kind: "text",
                text: question.description,
                analysis: {
                  status: "analyzed",
                  artifactId: "text-artifact",
                  assessment,
                  conditions: [question],
                  tasks: [],
                },
              },
            ],
          });
        },
        { assessment, question },
      );
    await mount();
    const card = page.locator('.analysis-card[data-condition-id="bulky"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator("[data-answer-key]")).toHaveCount(2);
    await page.reload();
    await mount();
    await expect(card).toHaveCount(1);
    guidanceFailed = true;
    await page.reload();
    await mount();
    await expect(page.locator("#retry-guidance")).toBeVisible();
    // Online questions must be revalidated before they can be acted on.
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-task-id="live-task"]')).toBeVisible();
    guidanceFailed = false;
    await page.locator("#retry-guidance").click();
    await expect(page.locator("#retry-guidance")).toHaveCount(0);
    await expect(card).toHaveCount(1);
    await card.locator('[data-analysis-action="edit"]').click();
    await page
      .locator("#analysis-edit-description")
      .fill("Updated description of the abandoned furniture.");
    await page.locator("#analysis-edit-save").click();
    await expect(page.locator("#analysis-edit-error")).toHaveText(
      t("analysis.editDialog.expired"),
    );
    await expect(page.locator("#analysis-edit-description")).toHaveValue(
      "Updated description of the abandoned furniture.",
    );
    await page
      .locator("#analysis-edit-dialog")
      .getByRole("button", {
        name: t("analysis.editDialog.discard"),
        exact: true,
      })
      .click();
    if (resolution === "dismiss") {
      await card.locator('[data-analysis-action="delete"]').click();
      await page.locator("#analysis-delete-confirm").click();
      await page.locator(".app-toast__close").click();
      await expect.poll(() => dismissals).toBe(1);
      await page.reload();
      await mount();
      await expect(card).toHaveCount(0);
      return;
    }
    await card.locator('[data-answer-value="false"]').click();
    await expect(
      page.locator('.analysis-card[data-task-id="bulky-task"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-answer-key="provider_generated"]'),
    ).toHaveCount(0);
    expect(answers).toBe(1);
  });
