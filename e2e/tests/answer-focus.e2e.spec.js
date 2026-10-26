import { test, expect } from "@playwright/test";

/**
 * @typedef {(Window & typeof globalThis) & { answerFixture: {
 *   root: HTMLElement,
 *   setQuestionAnswerBusy: (root: HTMLElement, conditionId: string, busy: boolean) => void
 * } }} AnswerFixtureWindow
 */

// Exercise the shared helper in a real browser: DOM-only unit mocks cannot
// reproduce focus loss when a focused button is disabled or removed.
/** @param {import("@playwright/test").Page} page */
async function setup(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    // This URL is resolved by the browser's Vite server, not Node/tsc.
    const moduleUrl = "/src/components/analysis-answer-controls.js";
    const { setQuestionAnswerBusy } = await import(moduleUrl);
    document.body.innerHTML =
      '<main id="fixture"><article class="analysis-card" data-condition-id="c"><div class="analysis-card__question-actions"><button id="yes" data-analysis-action="answer" data-condition-id="c" data-answer-value="true">Yes</button><button id="no" data-analysis-action="answer" data-condition-id="c" data-answer-value="false">No</button></div></article><button id="elsewhere">Other</button></main>';
    const root = document.querySelector("#fixture");
    const button = document.querySelector("#no");
    if (!(root instanceof window.HTMLElement) || !button)
      throw new Error("Answer fixture did not render");
    /** @type {AnswerFixtureWindow} */ (window).answerFixture = {
      setQuestionAnswerBusy,
      root,
    };
    button.addEventListener("click", () =>
      setQuestionAnswerBusy(root, "c", true),
    );
  });
  await page.locator("#no").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[role="status"]')).toBeFocused();
}

test("answer progress preserves keyboard focus through rerenders and successful replacement", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const { root, setQuestionAnswerBusy } = /** @type {AnswerFixtureWindow} */ (
      window
    ).answerFixture;
    const card = root.querySelector("article");
    if (!card) throw new Error("Answer card is missing");
    card.replaceWith(card.cloneNode(true));
    setQuestionAnswerBusy(root, "c", true);
  });
  await expect(page.locator('[role="status"]')).toBeFocused();
  await page.evaluate(() => {
    const { root, setQuestionAnswerBusy } = /** @type {AnswerFixtureWindow} */ (
      window
    ).answerFixture;
    const card = root.querySelector("article");
    if (!card) throw new Error("Answer card is missing");
    card.innerHTML = "<h2>Updated issue</h2>";
    setQuestionAnswerBusy(root, "c", false);
  });
  await expect(page.locator("article")).toBeFocused();
});

test("a failed answer restores focus to the original choice", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const { root, setQuestionAnswerBusy } = /** @type {AnswerFixtureWindow} */ (
      window
    ).answerFixture;
    setQuestionAnswerBusy(root, "c", false);
  });
  await expect(page.locator("#no")).toBeFocused();
  await expect(page.locator("#no")).toBeEnabled();
  await expect(page.locator('[role="status"]')).toHaveCount(0);
});

test("completion does not steal focus after the user moves away", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#elsewhere").focus();
  await page.evaluate(() => {
    const { root, setQuestionAnswerBusy } = /** @type {AnswerFixtureWindow} */ (
      window
    ).answerFixture;
    const card = root.querySelector("article");
    if (!card) throw new Error("Answer card is missing");
    card.innerHTML = "<h2>Updated issue</h2>";
    setQuestionAnswerBusy(root, "c", false);
  });
  await expect(page.locator("#elsewhere")).toBeFocused();
});
