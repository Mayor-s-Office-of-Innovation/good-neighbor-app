import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  toggleCardCompletion,
  completeCardAction,
  isCompletingAnalysisCard,
} from "./analysis-card-completion.js";
import { completeTask } from "../services/api.js";
import { showActionSaveErrorToast } from "../state/toasts.js";
vi.mock("./task-update-dialog.js", () => ({}));
vi.mock("../services/api.js", () => ({ completeTask: vi.fn() }));
vi.mock("../state/toasts.js", () => ({ showActionSaveErrorToast: vi.fn() }));
let host, card, button, callbacks, shell, animation;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const attrs = new Map();
  button = {
    disabled: false,
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k),
  };
  card = {
    isConnected: true,
    querySelectorAll: () => [button],
    getAttribute: () => "task",
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    before: vi.fn(),
  };
  host = {
    isConnected: true,
    contains: () => false,
    querySelector: () => null,
  };
  callbacks = { onSaved: vi.fn(), render: vi.fn() };
  animation = Promise.resolve();
  shell = {
    append: vi.fn(),
    getAnimations: () => [{ finished: animation }],
    remove: vi.fn(),
  };
  vi.stubGlobal("document", {
    createElement: () => shell,
    activeElement: button,
    body: {},
  });
  vi.mocked(completeTask).mockResolvedValue({ task: { status: "completed" } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("allows cancellation without sending a request", async () => {
  toggleCardCompletion(host, card, button, callbacks);
  expect(button.getAttribute("aria-checked")).toBe("true");
  await vi.advanceTimersByTimeAsync(1499);
  expect(completeTask).not.toHaveBeenCalled();
  toggleCardCompletion(host, card, button, callbacks);
  await vi.advanceTimersByTimeAsync(2000);
  expect(completeTask).not.toHaveBeenCalled();
  expect(isCompletingAnalysisCard(host)).toBe(false);
});
it("waits for a confirmed save and animation before updating the list", async () => {
  let resolveSave = (value) => {
      void value;
    },
    resolveAnimation = () => {};
  vi.mocked(completeTask).mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve;
    }),
  );
  animation = new Promise((resolve) => {
    resolveAnimation = () => resolve(undefined);
  });
  toggleCardCompletion(host, card, button, callbacks);
  await vi.advanceTimersByTimeAsync(1500);
  toggleCardCompletion(host, card, button, callbacks);
  expect(completeTask).toHaveBeenCalledTimes(1);
  expect(card.before).not.toHaveBeenCalled();
  resolveSave({ task: { status: "in_progress" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(card.before).toHaveBeenCalled();
  expect(callbacks.onSaved).not.toHaveBeenCalled();
  resolveAnimation();
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onSaved).toHaveBeenCalledWith({ status: "in_progress" });
  expect(callbacks.render).toHaveBeenCalledOnce();
});
it.each(["rejected", "unconfirmed"])(
  "restores a retryable card on %s save",
  async (kind) => {
    if (kind === "rejected")
      vi.mocked(completeTask).mockRejectedValue(new Error("offline"));
    else
      vi.mocked(completeTask).mockResolvedValue({ task: { status: "open" } });
    toggleCardCompletion(host, card, button, callbacks);
    await vi.advanceTimersByTimeAsync(1500);
    expect(card.before).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.disabled).toBe(false);
    expect(showActionSaveErrorToast).toHaveBeenCalledOnce();
  },
);
it("cancels an unsaved action when its card is detached", async () => {
  toggleCardCompletion(host, card, button, callbacks);
  host.isConnected = false;
  card.isConnected = false;
  await vi.advanceTimersByTimeAsync(1500);
  expect(completeTask).not.toHaveBeenCalled();
  expect(isCompletingAnalysisCard(host)).toBe(false);
});

it("keeps a completed card waiting until the results dialog closes", async () => {
  const task = {
    taskId: "task",
    status: "completed",
    canBeInProgress: false,
    latestUpdateId: "update",
  };
  vi.mocked(completeTask).mockResolvedValue({ task });
  let close = () => {};
  const dialog = {
    addEventListener: vi.fn((type, callback) => {
      close = callback;
    }),
    openResults: vi.fn(),
    remove: vi.fn(),
  };
  vi.stubGlobal("document", {
    createElement: () => dialog,
    body: { append: vi.fn() },
  });
  document.body.append = vi.fn();
  const finished = vi.fn();
  const saving = completeCardAction("task", {
    completionMethod: "manual",
  }).then(finished);
  await vi.advanceTimersByTimeAsync(0);
  expect(dialog.openResults).toHaveBeenCalledWith(task);
  expect(finished).not.toHaveBeenCalled();
  close();
  await saving;
  expect(dialog.remove).toHaveBeenCalledOnce();
  expect(finished).toHaveBeenCalledWith({ task });
});
