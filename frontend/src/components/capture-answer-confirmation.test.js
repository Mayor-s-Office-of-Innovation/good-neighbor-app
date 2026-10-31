import { beforeAll, beforeEach, expect, it, vi } from "vitest";
const feedback = vi.hoisted(() => ({
  busy: vi.fn(),
  show: vi.fn(),
  answer: vi.fn(async () => ({})),
}));
vi.mock("./analysis-answer-controls.js", () => ({
  setQuestionAnswerBusy: feedback.busy,
  showQuestionAnswerUpdated: feedback.show,
}));
vi.mock("../services/photo-analysis.js", async (importOriginal) => ({
  ...(await importOriginal()),
  answerAnalysisQuestion: feedback.answer,
}));
let component;
let reportComponent;
beforeEach(() => vi.clearAllMocks());
beforeAll(async () => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("HTMLButtonElement", class {});
  vi.stubGlobal("FileReader", { LOADING: 1 });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("customElements", { define: vi.fn() });
  await import("./perimeter-check.js");
  await import("./problem-report.js");
  reportComponent = vi
    .mocked(customElements.define)
    .mock.calls.find(([name]) => name === "problem-report")[1];
  component = vi
    .mocked(customElements.define)
    .mock.calls.find(([name]) => name === "perimeter-check")[1];
});
it("shows confirmation on the original question before rendering an answer that removes it", async () => {
  const view = {
    _answeringConditionIds: new Map(),
    isConnected: true,
    _render: vi.fn(),
  };
  const button = new HTMLButtonElement();
  button.getAttribute = (name) =>
    name === "data-answer-key" ? "provider_generated" : "true";
  await component.prototype._answerProblemQuestion.call(
    view,
    { itemId: "photo-1", conditionId: "shared" },
    button,
  );
  expect(view._render).not.toHaveBeenCalled();
  expect(view._answeringConditionIds.size).toBe(1);
  expect(feedback.show).toHaveBeenCalledWith(
    view,
    "shared",
    expect.objectContaining({
      itemId: "photo-1",
      onComplete: expect.any(Function),
    }),
  );
  feedback.show.mock.calls[0][2].onComplete();
  expect(view._render).toHaveBeenCalledOnce();
  expect(view._answeringConditionIds.size).toBe(0);
});
it("holds capture rerenders while an answer or its confirmation is pending", () => {
  expect(() =>
    component.prototype._render.call({
      _answeringConditionIds: new Map([["answer", {}]]),
    }),
  ).not.toThrow();
});

it.each(["perimeter", "report"])(
  "keeps an accepted %s question locked while another answer holds the render",
  async (kind) => {
    const prototype = (kind === "perimeter" ? component : reportComponent)
      .prototype;
    const view = {
      _answeringConditionIds: new Map(),
      isConnected: true,
      _render: vi.fn(),
    };
    const button = new HTMLButtonElement();
    button.getAttribute = (name) =>
      name === "data-answer-key" ? "provider_generated" : "true";
    const first = { itemId: "photo-1", conditionId: "shared" };
    const second = { itemId: "photo-2", conditionId: "shared" };
    await prototype._answerProblemQuestion.call(view, first, button);
    await prototype._answerProblemQuestion.call(view, second, button);
    feedback.show.mock.calls[0][2].onComplete();
    expect(view._render).not.toHaveBeenCalled();
    expect(feedback.busy.mock.calls.every((call) => call[2] === true)).toBe(
      true,
    );
    await prototype._answerProblemQuestion.call(view, first, button);
    expect(feedback.answer).toHaveBeenCalledTimes(2);
    feedback.show.mock.calls[1][2].onComplete();
    expect(view._render).toHaveBeenCalledOnce();
    expect(view._answeringConditionIds.size).toBe(0);
  },
);
