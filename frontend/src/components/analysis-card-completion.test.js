import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  toggleCardCompletion,
  completeCardAction,
  isCompletingAnalysisCard,
} from "./analysis-card-completion.js";
import { completeTask } from "../services/api.js";
import { getSite } from "../db.js";
import { showActionSaveErrorToast, showToast } from "../state/toasts.js";
vi.mock("../services/phone-completion.js", () => ({
  savePhoneCompletion: (taskId) =>
    completeTask(taskId, { completionMethod: "manual" }).catch((error) => {
      showActionSaveErrorToast();
      throw error;
    }),
}));
vi.mock("./task-update-dialog.js", () => ({}));
vi.mock("../db.js", () => ({
  getSite: vi.fn(async () => ({ siteId: "site" })),
}));
vi.mock("../services/api.js", () => ({ completeTask: vi.fn() }));
vi.mock("../state/toasts.js", () => ({
  showActionSaveErrorToast: vi.fn(),
  showToast: vi.fn(),
}));
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
  let finish = (_value) => {
    void _value;
  };
  vi.mocked(completeTask).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  toggleCardCompletion(host, card, button, callbacks);
  expect(button.getAttribute("aria-checked")).toBe("true");
  expect(button.disabled).toBe(true);
  expect(card.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
  await Promise.resolve();
  expect(completeTask).toHaveBeenCalledExactlyOnceWith(
    "task",
    {
      completionMethod: "manual",
    },
    { originSiteId: "site" },
  );
  toggleCardCompletion(host, card, button, callbacks);
  await Promise.resolve();
  expect(completeTask).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-checked")).toBe("true");
  expect(isCompletingAnalysisCard(host)).toBe(true);
  finish({ task: { status: "completed" } });
  await vi.advanceTimersByTimeAsync(0);
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
  await Promise.resolve();
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
it("animates completion without opening documentation even when results are pending", async () => {
  vi.mocked(completeTask).mockResolvedValue({
    task: { status: "completed", canBeInProgress: false },
    resultsPending: true,
  });
  toggleCardCompletion(host, card, button, callbacks);
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onSaved).toHaveBeenCalledOnce();
  expect(callbacks.render).toHaveBeenCalledOnce();
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

it("deduplicates concurrent saves without opening a modal", async () => {
  const create = vi.spyOn(document, "createElement");
  const first = completeCardAction("task", { completionMethod: "manual" });
  const second = completeCardAction("task", { completionMethod: "manual" });
  await Promise.all([first, second]);
  expect(completeTask).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});
it("does not share completion requests across sites", async () => {
  vi.mocked(getSite)
    .mockResolvedValueOnce({ siteId: "one" })
    .mockResolvedValueOnce({ siteId: "two" });
  await Promise.all([
    completeCardAction("same", { completionMethod: "manual" }),
    completeCardAction("same", { completionMethod: "manual" }),
  ]);
  expect(completeTask).toHaveBeenCalledTimes(2);
  expect(completeTask).toHaveBeenCalledWith(
    "same",
    { completionMethod: "manual" },
    { originSiteId: "one" },
  );
  expect(completeTask).toHaveBeenCalledWith(
    "same",
    { completionMethod: "manual" },
    { originSiteId: "two" },
  );
});

it("does not hide a real save failure when the prompt also fails", async () => {
  vi.mocked(completeTask).mockRejectedValue(new Error("save failed"));
  vi.stubGlobal("document", {
    createElement: () => {
      throw new Error("module unavailable");
    },
  });
  await expect(
    completeCardAction("failed", { completionMethod: "manual" }),
  ).rejects.toThrow("save failed");
  await vi.advanceTimersByTimeAsync(0);
  expect(showToast).not.toHaveBeenCalled();
});
