import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../components/error-notice.js", () => ({
  showInlineError: vi.fn().mockReturnValue(null),
}));
import { showInlineError } from "../components/error-notice.js";
import {
  getToasts,
  showToast,
  showTaskUpdateErrorToast,
  show311FilingToast,
  showDeletionRefreshToast,
} from "./toasts.js";
import { t } from "../i18n/i18n.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  while (getToasts().length) getToasts().forEach((toast) => toast.close(true));
  vi.mocked(showInlineError).mockReset().mockReturnValue(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("preserves overlapping pause reasons and original Undo lifetime", async () => {
  const save = vi.fn();
  const toast = showToast({
    title: "Synthetic deletion",
    message: "",
    onDismiss: save,
  });
  await vi.advanceTimersByTimeAsync(1000);
  toast.pause("pointer");
  toast.pause("focus");
  toast.pause("hidden");
  await vi.advanceTimersByTimeAsync(20000);
  toast.resume("pointer");
  toast.resume("hidden");
  await vi.advanceTimersByTimeAsync(20000);
  expect(save).not.toHaveBeenCalled();
  toast.resume("focus");
  await vi.advanceTimersByTimeAsync(2499);
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledOnce();
});
it("keeps independent Undo windows visible and committing on their original schedule", async () => {
  const firstSave = vi.fn(),
    secondSave = vi.fn(),
    undo = vi.fn();
  const first = showToast({
    title: "First",
    message: "",
    onDismiss: firstSave,
    action: { label: "Undo", run: undo },
  });
  await vi.advanceTimersByTimeAsync(1000);
  showToast({ title: "Second", message: "", onDismiss: secondSave });
  expect(getToasts()).toHaveLength(2);
  first.close(true);
  await vi.advanceTimersByTimeAsync(3500);
  expect(undo).toHaveBeenCalledOnce();
  expect(firstSave).not.toHaveBeenCalled();
  expect(secondSave).toHaveBeenCalledOnce();
});
it("queues ordinary notices without consuming their visible lifetime", async () => {
  const first = showToast({ title: "One", message: "" });
  const next = showToast({ title: "Two", message: "" });
  expect(getToasts()).toEqual([first]);
  await vi.advanceTimersByTimeAsync(3500);
  expect(getToasts()).toEqual([next]);
  await vi.advanceTimersByTimeAsync(3499);
  expect(getToasts()).toEqual([next]);
  await vi.advanceTimersByTimeAsync(1);
  expect(getToasts()).toEqual([]);
});
it("deduplicates one operation but preserves distinct persistent Retry actions", () => {
  const one = showToast({ title: "Job", message: "", key: "job:1" });
  expect(showToast({ title: "Job", message: "", key: "job:1" })).toBe(one);
  const retry1 = vi.fn(),
    retry2 = vi.fn();
  const first = showTaskUpdateErrorToast(undefined, retry1);
  const second = showTaskUpdateErrorToast(undefined, retry2);
  one.close();
  expect(getToasts()).toContain(first);
  first.close(true);
  expect(retry1).toHaveBeenCalledOnce();
  expect(getToasts()).toContain(second);
  second.close(true);
  expect(retry2).toHaveBeenCalledOnce();
});
it("routes refresh warnings inline for five seconds without a toast", () => {
  const local = { close: vi.fn(), isConnected: () => true };
  vi.mocked(showInlineError).mockReturnValueOnce(local);
  expect(showDeletionRefreshToast()).toBe(local);
  expect(showInlineError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ duration: 5000 }),
  );
  expect(getToasts()).toEqual([]);
});
it("acknowledges 311 filing without a later success message", () => {
  const toast = show311FilingToast({ status: "in_progress" });
  expect(toast.title).toBe(t("toast.ticketQueued.title"));
});
