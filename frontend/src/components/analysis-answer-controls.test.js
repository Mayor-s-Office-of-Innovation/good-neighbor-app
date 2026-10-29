import { afterEach, expect, it, vi } from "vitest";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";
import { t } from "../i18n/i18n.js";

class Button {
  disabled = false;
  hidden = false;
  constructor(conditionId, group) {
    this.conditionId = conditionId;
    this.group = group;
  }
  getAttribute() {
    return this.conditionId;
  }
  closest() {
    return this.group;
  }
}
function fixture() {
  const group = {
    progress: null,
    markup: "",
    querySelector() {
      return this.progress;
    },
    insertAdjacentHTML(_position, markup) {
      this.markup = markup;
      this.progress = {
        remove: () => {
          this.progress = null;
        },
      };
    },
  };
  const buttons = [
    new Button("one", group),
    new Button("one", group),
    new Button("two", null),
  ];
  return {
    group,
    buttons,
    root: /** @type {HTMLElement} */ (
      /** @type {unknown} */ ({ querySelectorAll: () => buttons })
    ),
  };
}
afterEach(() => vi.unstubAllGlobals());
it("replaces both choices with one accessible progress indicator and restores them on failure", () => {
  vi.stubGlobal("HTMLButtonElement", Button);
  const { root, buttons, group } = fixture();
  setQuestionAnswerBusy(root, "one", true);
  setQuestionAnswerBusy(root, "one", true);
  expect(
    buttons.slice(0, 2).every((button) => button.hidden && button.disabled),
  ).toBe(true);
  expect(buttons[2].hidden).toBe(false);
  expect(group.markup).toContain('role="status"');
  expect(group.markup).toContain('<wa-spinner aria-hidden="true">');
  expect(group.markup).toContain(t("analysis.question.updating"));
  setQuestionAnswerBusy(root, "one", false);
  expect(buttons.every((button) => !button.hidden && !button.disabled)).toBe(
    true,
  );
  expect(group.progress).toBeNull();
});
it("can reapply progress after a card rerender", () => {
  vi.stubGlobal("HTMLButtonElement", Button);
  const initial = fixture();
  setQuestionAnswerBusy(initial.root, "one", true);
  const rendered = fixture();
  setQuestionAnswerBusy(rendered.root, "one", true);
  expect(rendered.group.progress).not.toBeNull();
  expect(rendered.buttons[0].hidden).toBe(true);
});

it("keeps the success overlay for two seconds and reapplies it after rerenders", async () => {
  vi.useFakeTimers();
  let notify = () => {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback) {
        notify = callback;
      }
      observe() {}
      disconnect = vi.fn();
    },
  );
  const card = (id) => ({
    overlay: null,
    children: [],
    getAttribute: () => id,
    querySelector() {
      return this.overlay;
    },
    insertAdjacentHTML(_position, markup) {
      this.markup = markup;
      this.overlay = {
        remove: () => {
          this.overlay = null;
        },
      };
    },
  });
  let updated = card("one");
  const other = card("two");
  const root = { querySelectorAll: () => [updated, other] };
  const { showQuestionAnswerUpdated } = await import(
    "./analysis-answer-controls.js"
  );
  try {
    showQuestionAnswerUpdated(
      /** @type {HTMLElement} */ (/** @type {unknown} */ (root)),
      "one",
    );
    expect(updated.markup).toContain(t("analysis.question.updated"));
    expect(updated.markup).toContain('role="status"');
    expect(other.overlay).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    updated = card("one");
    notify();
    expect(updated.overlay).not.toBeNull();
    expect(updated.markup).toContain('aria-hidden="true"');
    expect(updated.markup).not.toContain('role="status"');
    await vi.advanceTimersByTimeAsync(999);
    expect(updated.overlay).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(updated.overlay).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("makes covered content inert, preserves existing inert state, and restarts repeated confirmations", async () => {
  vi.useFakeTimers();
  class Content {
    constructor(inert = false) {
      this.inert = inert;
    }
    classList = { contains: () => false };
    contains = () => false;
  }
  vi.stubGlobal("HTMLElement", Content);
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const content = new Content();
  const alreadyInert = new Content(true);
  const card = {
    children: [content, alreadyInert],
    overlay: null,
    getAttribute: () => "one",
    querySelector() {
      return this.overlay;
    },
    insertAdjacentHTML() {
      this.overlay = {
        remove: () => {
          this.overlay = null;
        },
      };
    },
  };
  const root = /** @type {HTMLElement} */ (
    /** @type {unknown} */ ({ querySelectorAll: () => [card] })
  );
  const { showQuestionAnswerUpdated } = await import(
    "./analysis-answer-controls.js"
  );
  try {
    showQuestionAnswerUpdated(root, "one");
    expect(content.inert).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    showQuestionAnswerUpdated(root, "one");
    await vi.advanceTimersByTimeAsync(1000);
    expect(card.overlay).not.toBeNull();
    expect(content.inert).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(card.overlay).toBeNull();
    expect(content.inert).toBe(false);
    expect(alreadyInert.inert).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
