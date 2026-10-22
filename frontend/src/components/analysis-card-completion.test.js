import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  toggleCardCompletion,
  completeCardAction,
  isCompletingAnalysisCard,
} from "./analysis-card-completion.js";
import { completeTask } from "../services/api.js";
import { showActionSaveErrorToast } from "../state/toasts.js";
vi.mock("../services/phone-completion.js", () => ({
  savePhoneCompletion: (taskId) =>
    completeTask(taskId, { completionMethod: "manual" }).catch((error) => {
      showActionSaveErrorToast();
      throw error;
    }),
}));
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
it("sends the request on the first tap and ignores a second tap while it is in flight", async () => {
  vi.mocked(completeTask).mockReturnValue(new Promise(() => {}));
  toggleCardCompletion(host, card, button, callbacks);
  expect(button.getAttribute("aria-checked")).toBe("true");
  expect(button.disabled).toBe(true);
  expect(card.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
  expect(completeTask).toHaveBeenCalledExactlyOnceWith("task", {
    completionMethod: "manual",
  });
  toggleCardCompletion(host, card, button, callbacks);
  expect(completeTask).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-checked")).toBe("true");
  expect(isCompletingAnalysisCard(host)).toBe(true);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(card.before).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.disabled).toBe(false);
    expect(showActionSaveErrorToast).toHaveBeenCalledOnce();
  },
);
it("keeps a completed card waiting until the results dialog closes", async () => {
  const task = {
    taskId: "task",
    status: "completed",
    canBeInProgress: false,
    latestUpdateId: "update",
  };
  vi.mocked(completeTask).mockResolvedValue({ task, resultsPending: true });
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
  expect(dialog.openResults).toHaveBeenCalledWith(task, null);
  expect(finished).not.toHaveBeenCalled();
  close();
  await saving;
  expect(dialog.remove).toHaveBeenCalledOnce();
  expect(finished).toHaveBeenCalledWith({ task, resultsPending: true });
});

it("does not reopen capture for a replay whose results are closed", async () => {
  const result = {
    task: {
      status: "completed",
      canBeInProgress: false,
      latestUpdateId: "update",
    },
    resultsPending: false,
  };
  vi.mocked(completeTask).mockResolvedValue(result);
  const create = vi.spyOn(document, "createElement");
  await expect(
    completeCardAction("task", { completionMethod: "manual" }),
  ).resolves.toEqual(result);
  expect(create).not.toHaveBeenCalled();
});

it("starts saving a phone action immediately and opens the dialer once", async () => {
  const location = { href: "" };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), location });
  button.setAttribute("data-phone-number", "415-553-0123");
  vi.mocked(completeTask).mockResolvedValue({
    task: { status: "in_progress" },
  });
  toggleCardCompletion(host, card, button, callbacks);
  toggleCardCompletion(host, card, button, callbacks);
  expect(completeTask).toHaveBeenCalledExactlyOnceWith("task", {
    completionMethod: "manual",
  });
  expect(location.href).toBe("tel:4155530123");
  expect(button.getAttribute("aria-checked")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onSaved).toHaveBeenCalledWith({ status: "in_progress" });
});

it("clears busy before the slide and ignores a looping animation", async () => {
  shell.getAnimations = () => [
    {
      finished: new Promise(() => {}),
      effect: { getTiming: () => ({ iterations: Infinity }) },
    },
    { finished: animation, effect: { getTiming: () => ({ iterations: 1 }) } },
  ];
  toggleCardCompletion(host, card, button, callbacks);
  await vi.advanceTimersByTimeAsync(0);
  expect(card.removeAttribute).toHaveBeenCalledWith("aria-busy");
  expect(callbacks.onSaved).toHaveBeenCalledWith({ status: "completed" });
  expect(callbacks.render).toHaveBeenCalled();
});

it("dials only a plain digit string from the phone attribute", () => {
  const location = { href: "" };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), location });
  button.setAttribute("data-phone-number", "javascript:alert(1)");
  toggleCardCompletion(host, card, button, callbacks);
  expect(location.href).toBe("");
});

it("does not launch a phone CTA outside the mobile viewport", () => {
  const location = { href: "" };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), location });
  button.setAttribute("data-phone-number", "911");
  toggleCardCompletion(host, card, button, callbacks);
  expect(completeTask).not.toHaveBeenCalled();
  expect(location.href).toBe("");
});

it("leaves failed phone saves retryable without checkbox semantics", async () => {
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: true }),
    location: { href: "" },
  });
  button.setAttribute("data-phone-number", "311");
  vi.mocked(completeTask).mockRejectedValue(new Error("offline"));
  toggleCardCompletion(host, card, button, callbacks);
  await vi.advanceTimersByTimeAsync(0);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-checked")).toBeUndefined();
  expect(showActionSaveErrorToast).toHaveBeenCalledOnce();
});

function resultsDialogStub() {
  const dialog = {
    addEventListener: vi.fn((type, callback) => {
      dialog.close = callback;
    }),
    close: () => {},
    openResults: vi.fn(),
    remove: vi.fn(),
  };
  return dialog;
}

it("opens the results prompt at tap time and lets the response arrive behind it", async () => {
  const task = { taskId: "task", canBeInProgress: false, checkId: "check" };
  let resolveSave = (value) => {
    void value;
  };
  vi.mocked(completeTask).mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve;
    }),
  );
  const dialog = resultsDialogStub();
  vi.stubGlobal("document", {
    createElement: (tag) => (tag === "task-update-dialog" ? dialog : shell),
    activeElement: button,
    body: { append: vi.fn() },
  });
  toggleCardCompletion(host, card, button, { ...callbacks, task });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.body.append).toHaveBeenCalledWith(dialog);
  const [promptedTask, completion] = dialog.openResults.mock.calls[0];
  expect(promptedTask).toBe(task);
  expect(completion).toBeInstanceOf(Promise);
  expect(card.before).not.toHaveBeenCalled();
  const saved = {
    task: { taskId: "task", status: "completed", latestUpdateId: "update" },
    resultsPending: true,
  };
  resolveSave(saved);
  await expect(completion).resolves.toEqual({ task: saved.task });
  // The card waits for the prompt to close before it slides away.
  expect(card.before).not.toHaveBeenCalled();
  dialog.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(dialog.remove).toHaveBeenCalledOnce();
  expect(card.before).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onSaved).toHaveBeenCalledWith(saved.task);
});

it("tells the prompt when the action failed or produced no results", async () => {
  const task = { taskId: "task", canBeInProgress: false };
  const dialog = resultsDialogStub();
  vi.stubGlobal("document", {
    createElement: () => dialog,
    activeElement: button,
    body: { append: vi.fn() },
  });
  vi.mocked(completeTask).mockRejectedValue(new Error("offline"));
  const failing = completeCardAction(
    "task",
    { completionMethod: "manual" },
    { task },
  );
  await vi.advanceTimersByTimeAsync(0);
  await expect(dialog.openResults.mock.calls[0][1]).resolves.toEqual({
    task: null,
    failed: true,
  });
  dialog.close();
  await expect(failing).rejects.toThrow("offline");

  vi.mocked(completeTask).mockResolvedValue({
    task: { status: "in_progress" },
    resultsPending: false,
  });
  const quiet = completeCardAction(
    "task",
    { completionMethod: "manual" },
    { task },
  );
  await vi.advanceTimersByTimeAsync(0);
  await expect(dialog.openResults.mock.calls[1][1]).resolves.toEqual({
    task: null,
  });
  dialog.close();
  await expect(quiet).resolves.toEqual({
    task: { status: "in_progress" },
    resultsPending: false,
  });
});

it("shows results prompts one at a time, in tap order", async () => {
  const dialogs = [resultsDialogStub(), resultsDialogStub()];
  let created = 0;
  vi.stubGlobal("document", {
    createElement: () => dialogs[created++],
    activeElement: button,
    body: { append: vi.fn() },
  });
  vi.mocked(completeTask).mockReturnValue(new Promise(() => {}));
  const tasks = [
    { taskId: "first", canBeInProgress: false },
    { taskId: "second", canBeInProgress: false },
  ];
  tasks.forEach(
    (task) =>
      void completeCardAction(
        task.taskId,
        { completionMethod: "manual" },
        { task },
      ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(completeTask).toHaveBeenCalledTimes(2);
  expect(dialogs[0].openResults).toHaveBeenCalledWith(
    tasks[0],
    expect.any(Promise),
  );
  expect(created).toBe(1);
  dialogs[0].close();
  await vi.advanceTimersByTimeAsync(0);
  expect(created).toBe(2);
  expect(dialogs[1].openResults).toHaveBeenCalledWith(
    tasks[1],
    expect.any(Promise),
  );
  // Drain the module-level queue so later tests start with no open prompt.
  dialogs[1].close();
  await vi.advanceTimersByTimeAsync(0);
});

it("reports a queued card's failure without waiting for the open prompt", async () => {
  const dialogs = [resultsDialogStub(), resultsDialogStub()];
  let created = 0;
  vi.stubGlobal("document", {
    createElement: () => dialogs[created++],
    activeElement: button,
    body: { append: vi.fn() },
  });
  const tasks = [
    { taskId: "first", canBeInProgress: false },
    { taskId: "second", canBeInProgress: false },
  ];
  vi.mocked(completeTask).mockReturnValueOnce(new Promise(() => {}));
  void completeCardAction(
    "first",
    { completionMethod: "manual" },
    { task: tasks[0] },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(created).toBe(1);
  vi.mocked(completeTask).mockRejectedValueOnce(new Error("offline"));
  const failing = completeCardAction(
    "second",
    { completionMethod: "manual" },
    { task: tasks[1] },
  );
  // The first prompt is still open; the second card hears back anyway.
  await expect(failing).rejects.toThrow("offline");
  dialogs[0].close();
  await vi.advanceTimersByTimeAsync(0);
  // Its turn in the queue is skipped: no second prompt is ever created.
  expect(created).toBe(1);
});

it("skips the prompt for actions the backend never documents", async () => {
  vi.mocked(completeTask).mockResolvedValue({
    task: { status: "in_progress" },
  });
  const create = vi.spyOn(document, "createElement");
  await completeCardAction(
    "task",
    { completionMethod: "manual" },
    { task: { taskId: "task", canBeInProgress: true } },
  );
  await completeCardAction(
    "task",
    { completionMethod: "311_filed" },
    { task: { taskId: "task", canBeInProgress: false } },
  );
  expect(create).not.toHaveBeenCalled();
});
