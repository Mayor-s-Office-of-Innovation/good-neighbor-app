import { test, expect } from "@playwright/test";

test("question reorder retains unchanged cards and loaded photos", async ({
  page,
}) => {
  await page.route("**/__card_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><main id="host"></main></body></html>',
    }),
  );
  await page.goto("/__card_test");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/components/home-card-reconcile.js";
    const { reconcileHomeResults } = await import(modulePath);
    const host = document.querySelector("#host");
    if (!host) throw new Error("Missing test host");
    const image =
      "<img src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E\">";
    const card = (/** @type {string} */ id, /** @type {string} */ content) =>
      `<article class="analysis-card" data-check-id="check" data-condition-id="${id}">${content}</article>`;
    const shell = (/** @type {string} */ cards) =>
      `<div class="home"><header>To do</header><section class="home-region--results"><div class="tray">${cards}</div></section></div>`;
    const first = shell(
      card("a", "Question A") +
        card("b", image + "<button>Question B</button>"),
    );
    const next = shell(
      card("b", image + "<button>Question B</button>") + card("a", "Result A"),
    );
    host.innerHTML = first;
    const held = host.querySelector('[data-condition-id="b"]');
    if (!held) throw new Error("Missing card");
    const photo = held.querySelector("img");
    let taps = 0;
    const button = held.querySelector("button");
    if (!button) throw new Error("Missing question button");
    button.addEventListener("click", () => taps++);
    const patched = reconcileHomeResults(host, first, next);
    button.click();
    return {
      patched,
      sameCard: held === host.querySelector('[data-condition-id="b"]'),
      samePhoto: photo === host.querySelector("img"),
      taps,
      order: [...host.querySelectorAll("article")].map((node) =>
        node.getAttribute("data-condition-id"),
      ),
    };
  });
  expect(result).toEqual({
    patched: true,
    sameCard: true,
    samePhoto: true,
    taps: 1,
    order: ["b", "a"],
  });
  await expect(page.locator("img")).toHaveJSProperty("naturalWidth", 1);
});

test("answer commit preserves the next question position and keyboard focus", async ({
  page,
}) => {
  await page.route("**/__answer_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0} .analysis-card{height:220px} #spacer{height:1200px}</style></head><body><div id="spacer"></div></body></html>',
    }),
  );
  await page.route(
    "**/v1/assessments/a/conditions/q1/answers",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        json: {
          assessmentItem: { assessmentId: "a", assessmentRevision: 2 },
          conditionItem: { conditionId: "q1", status: "tasks_created" },
          taskItem: {
            taskId: "t1",
            conditionId: "q1",
            assessmentId: "a",
            status: "open",
          },
        },
      });
    },
  );
  await page.goto("/__answer_test");
  await page.evaluate(async () => {
    const modulePath = "/src/components/today-view.js";
    const dbPath = "/src/db.js";
    await import(modulePath);
    const { setSite } = await import(dbPath);
    await setSite("Example", {
      siteId: "example",
      deviceId: "synthetic-device",
      token: "synthetic-test-token",
    });
    const Base = /** @type {any} */ (window.customElements.get("today-view"));
    class AnswerTest extends Base {
      connectedCallback() {}
      disconnectedCallback() {}
    }
    window.customElements.define(
      "answer-test",
      /** @type {CustomElementConstructor} */ (
        /** @type {unknown} */ (AnswerTest)
      ),
    );
    const view = /** @type {any} */ (document.createElement("answer-test"));
    view._siteId = "example";
    view._localQuestionItemId = async () => null;
    view._quietQuestionRefresh = async () => {};
    view._restoreFocusAfterRender = () => {};
    view._render = (/** @type {any} */ model) =>
      `<div class="home"><section class="home-region--results">${model.pendingQuestions.map((/** @type {any} */ item) => `<article class="analysis-card" data-check-id="check" data-item-id="${item.id}" data-condition-id="${item.analysis.conditions[0].conditionId}"><button data-analysis-action="answer" data-condition-id="${item.analysis.conditions[0].conditionId}" data-answer-key="provider_generated" data-answer-value="true">${item.id}</button></article>`).join("")}${model.tasks.map((/** @type {any} */ task) => `<article class="analysis-card" data-check-id="check" data-condition-id="${task.conditionId}" data-task-id="${task.taskId}">Result</article>`).join("")}</section></div>`;
    document.body.append(view);
    view._renderHome({
      tasks: [],
      pendingSession: null,
      pendingQuestions: ["q1", "q2"].map((id) => ({
        id,
        checkId: "check",
        kind: "text",
        analysis: {
          status: "analyzed",
          assessment: { assessmentId: "a", assessmentRevision: 1 },
          conditions: [{ conditionId: id, status: "needs_answer" }],
        },
      })),
    });
    window.scrollTo(0, 1000);
  });
  const next = page.locator('[data-condition-id="q2"].analysis-card');
  await page.locator('button[data-condition-id="q1"]').focus();
  const before = await next.boundingBox();
  await page.keyboard.press("Enter");
  await expect(
    page.locator('[data-condition-id="q1"] .analysis-card__updated'),
  ).toBeVisible();
  await expect(page.locator('[data-task-id="t1"]')).toHaveCount(0);
  await expect(page.locator(".analysis-card").first()).toHaveAttribute(
    "data-condition-id",
    "q1",
  );
  const during = await next.boundingBox();
  if (!during || !before) throw new Error("Missing question bounds");
  expect(Math.abs(during.y - before.y)).toBeLessThan(2);
  await expect(
    page.locator('[data-condition-id="q1"] .analysis-card__updated'),
  ).toHaveCount(0);
  await expect(page.locator('[data-task-id="t1"]')).toHaveCount(1);
  await expect(page.locator('button[data-condition-id="q2"]')).toBeFocused();
  const after = await next.boundingBox();
  if (!after || !before) throw new Error("Missing question bounds");
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});

test("answer feedback targets one photo when condition IDs are shared", async ({
  page,
}) => {
  await page.route("**/__scope_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><main id="cards">${["photo-1", "photo-2"].map((id) => `<article class="analysis-card" data-item-id="${id}" data-condition-id="shared"><div class="analysis-card__question-actions"><button data-analysis-action="answer" data-condition-id="shared">Yes</button></div></article>`).join("")}</main></body></html>`,
    }),
  );
  await page.goto("/__scope_test");
  await page.evaluate(async () => {
    const modulePath = "/src/components/analysis-answer-controls.js";
    const { setQuestionAnswerBusy, showQuestionAnswerUpdated } = await import(
      modulePath
    );
    const root = document.querySelector("#cards");
    setQuestionAnswerBusy(root, "shared", true, { itemId: "photo-1" });
    showQuestionAnswerUpdated(root, "shared", { itemId: "photo-1" });
  });
  await expect(
    page.locator('[data-item-id="photo-1"] .analysis-card__updated'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-item-id="photo-2"] .analysis-card__updated'),
  ).toHaveCount(0);
  await expect(page.locator('[data-item-id="photo-1"] button')).toBeDisabled();
  await expect(page.locator('[data-item-id="photo-2"] button')).toBeEnabled();
  // Perimeter capture replaces card markup as analyses settle. Scope survives it.
  await page.evaluate(() => {
    const first = document.querySelector('[data-item-id="photo-1"]');
    if (!first) throw new Error("Missing first photo");
    first.outerHTML =
      '<article class="analysis-card" data-item-id="photo-1" data-condition-id="shared"><p>Updated first photo</p></article>';
  });
  await expect(
    page.locator('[data-item-id="photo-1"] .analysis-card__updated'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-item-id="photo-2"] .analysis-card__updated'),
  ).toHaveCount(0);
});

test("same condition on different photos preserves each card through updates and reordering", async ({
  page,
}) => {
  await page.route("**/__card_identity_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main id="host"></main>',
    }),
  );
  await page.goto("/__card_identity_test");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/components/home-card-reconcile.js";
    const { reconcileHomeResults } = await import(modulePath);
    const host = document.querySelector("#host");
    if (!host) throw new Error("Missing host");
    const card = (
      /** @type {string} */ item,
      /** @type {string} */ text = item,
    ) =>
      `<article class="analysis-card" data-check-id="check" data-item-id="${item}" data-condition-id="litter"><button>${text}</button></article>`;
    const shell = (/** @type {string} */ cards, /** @type {string} */ count) =>
      `<section class="home-region--results"><p>${count}</p><div>${cards}</div></section>`;
    const first = shell(card("photo-A") + card("photo-B"), "2");
    host.innerHTML = first;
    const heldA = host.querySelector('[data-item-id="photo-A"]');
    const heldB = host.querySelector('[data-item-id="photo-B"]');
    let taps = 0;
    heldB?.querySelector("button")?.addEventListener("click", () => taps++);
    const updated = shell(card("photo-A") + card("photo-B"), "Updated count");
    const patched = reconcileHomeResults(host, first, updated);
    const sameA = heldA === host.querySelector('[data-item-id="photo-A"]');
    const sameB = heldB === host.querySelector('[data-item-id="photo-B"]');
    const next = shell(
      card("photo-B") + card("photo-A", "Answered A"),
      "Updated count",
    );
    reconcileHomeResults(host, updated, next);
    host.querySelector("button")?.click();
    return {
      patched,
      sameA,
      sameB,
      taps,
      order: [...host.querySelectorAll("article")].map((node) =>
        node.getAttribute("data-item-id"),
      ),
      text: heldB?.textContent,
    };
  });
  expect(result).toEqual({
    patched: true,
    sameA: true,
    sameB: true,
    taps: 1,
    order: ["photo-B", "photo-A"],
    text: "photo-B",
  });
});

test("question focus restoration distinguishes photos with the same condition", async ({
  page,
}) => {
  await page.route("**/__anchor_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main id="host"><article class="analysis-card" data-check-id="check" data-item-id="photo-A" data-condition-id="litter"><button>A</button></article><article class="analysis-card" data-check-id="check" data-item-id="photo-B" data-condition-id="litter"><button>B</button></article></main>',
    }),
  );
  await page.goto("/__anchor_test");
  const focused = await page.evaluate(async () => {
    const path = "/src/components/today-view.js";
    await import(path);
    const Base = /** @type {any} */ (window.customElements.get("today-view"));
    const host = document.querySelector("#host");
    if (!host) throw new Error("Missing host");
    const anchor = host.querySelector('[data-item-id="photo-B"]');
    if (!anchor) throw new Error("Missing anchor");
    Base.prototype._restoreQuestionAnchor.call({
      _questionAnchor: {
        id: "litter",
        itemId: "photo-B",
        checkId: "check",
        top: anchor.getBoundingClientRect().top,
        keyboard: true,
      },
      querySelectorAll: host.querySelectorAll.bind(host),
      querySelector: host.querySelector.bind(host),
    });
    return document.activeElement?.textContent;
  });
  expect(focused).toBe("B");
});

test("finishing status removal preserves live tabs, keyboard handlers and cards", async ({
  page,
}) => {
  await page.route("**/__tabs_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main id="host"></main>',
    }),
  );
  await page.goto("/__tabs_test");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/components/home-card-reconcile.js";
    const { reconcileHomeResults } = await import(modulePath);
    const host = /** @type {HTMLElement} */ (document.querySelector("#host"));
    /** @param {boolean} finishing */
    const markup = (finishing) =>
      `<section class="home-region--results"><div class="home-results">${finishing ? '<p role="status">Finishing</p>' : ""}<div class="home-tabs"><button data-home-filter="todo">To do</button><button data-home-filter="history">History</button></div><article class="analysis-card" data-task-id="task">Issue</article></div></section>`;
    host.innerHTML = markup(true);
    const buttons = [...host.querySelectorAll("button")];
    const card = /** @type {HTMLElement} */ (host.querySelector("article"));
    let clicks = 0;
    let keys = 0;
    buttons[1].addEventListener("click", () => clicks++);
    buttons[1].addEventListener("keydown", () => keys++);
    const patched = reconcileHomeResults(host, markup(true), markup(false));
    /** @type {HTMLElement} */ (
      host.querySelector('[data-home-filter="history"]')
    ).click();
    /** @type {HTMLElement} */ (
      host.querySelector('[data-home-filter="history"]')
    ).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    return {
      patched,
      clicks,
      keys,
      retainedTab:
        buttons[1] ===
        /** @type {HTMLElement} */ (
          host.querySelector('[data-home-filter="history"]')
        ),
      retainedCard:
        card === /** @type {HTMLElement} */ (host.querySelector("article")),
    };
  });
  expect(result).toEqual({
    patched: true,
    clicks: 1,
    keys: 1,
    retainedTab: true,
    retainedCard: true,
  });
  await page.locator('[data-home-filter="history"]').focus();
  await expect(page.locator('[data-home-filter="history"]')).toBeFocused();
});

test("reopening single issue after Done starts empty and preserves pending evidence", async ({
  page,
}) => {
  await page.route("**/__report_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await page.goto("/__report_test");
  const result = await page.evaluate(async () => {
    const dbPath = "/src/db.js";
    const statePath = "/src/state/check-session.js";
    const componentPath = "/src/components/problem-report.js";
    const db = await import(dbPath);
    await db.setSite("Synthetic test site", { siteId: "site-test" });
    const state = await import(statePath);
    state.startProblemReport("site-test");
    const old = state.getCurrentCheck();
    state.addItem({ kind: "text", text: "Synthetic pending evidence" });
    state.markCaptureComplete({
      checkId: old.id,
      submissionKind: "problem_report",
      expectedArtifacts: 1,
    });
    await import(componentPath);
    const element = document.createElement("problem-report");
    document.body.append(element);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Report did not initialize")),
        5000,
      );
      const poll = () => {
        if (element.querySelector("#file-input")) {
          clearTimeout(timer);
          resolve(undefined);
        } else setTimeout(poll, 10);
      };
      poll();
    });
    const current = state.getCurrentCheck();
    const result = {
      fresh: current.id !== old.id,
      items: current.items.length,
      oldItems: state.getCheck(old.id).items.length,
      oldStatus: state.getCheck(old.id).status,
    };
    element.remove();
    return result;
  });
  expect(result).toEqual({
    fresh: true,
    items: 0,
    oldItems: 1,
    oldStatus: "capture-complete",
  });
});
