import { test, expect } from "@playwright/test";

const assessment = { assessmentId: "old-assessment", checkId: "old-check" };
const question = {
  conditionId: "bulky",
  canonicalCategory: "Bulky items",
  status: "needs_answer",
  description: "Abandoned furniture on the sidewalk.",
  createdAt: "2026-10-27T12:00:00Z",
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

test("unanswered questions survive reload and later checks, then create a task when answered", async ({
  page,
}) => {
  let answered = false;
  let answers = 0;
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
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
            answered && url.searchParams.get("status") === "open" ? [task] : [],
        },
      });
    if (url.pathname === "/v1/checks")
      return route.fulfill({
        json: {
          checks: [
            {
              checkId: "newer-check",
              status: "completed",
              startedAt: "2026-10-28T12:00:00Z",
              completedAt: "2026-10-28T12:01:00Z",
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
      await setSite("Test site", { siteId: "test-site", token: "test-token" });
      document.body.append(document.createElement("today-view"));
    });
  await page.goto("/__pending_test");
  await mount();
  const card = page.locator('.analysis-card[data-condition-id="bulky"]');
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-answer-key]")).toHaveCount(2);
  await page.reload();
  await mount();
  await expect(card).toHaveCount(1);
  await card.locator('[data-answer-value="false"]').click();
  await expect(
    page.locator('.analysis-card[data-task-id="bulky-task"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-answer-key="provider_generated"]'),
  ).toHaveCount(0);
  expect(answers).toBe(1);
});
