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
