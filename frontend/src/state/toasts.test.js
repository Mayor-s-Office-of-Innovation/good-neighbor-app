import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getToasts,
  showToast,
  show311SuccessToast,
  show311ErrorToast,
} from "./toasts.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  getToasts().forEach((toast) => toast.close(true));
  vi.useRealTimers();
});

describe("toast lifetime", () => {
  it("preserves remaining time across overlapping hover, focus, and hidden-page pauses", async () => {
    const save = vi.fn();
    const toast = showToast({
      title: "Deleted",
      message: "Item",
      onDismiss: save,
    });
    await vi.advanceTimersByTimeAsync(4000);
    toast.pause("pointer");
    toast.pause("focus");
    toast.pause("hidden");
    await vi.advanceTimersByTimeAsync(20000);
    toast.resume("pointer");
    toast.resume("hidden");
    await vi.advanceTimersByTimeAsync(20000);
    expect(save).not.toHaveBeenCalled();
    toast.resume("focus");
    await vi.advanceTimersByTimeAsync(5999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps multiple deletion Undo windows independent", async () => {
    const firstSave = vi.fn();
    const secondSave = vi.fn();
    const undo = vi.fn();
    const first = showToast({
      title: "First",
      message: "",
      onDismiss: firstSave,
      action: { label: "Undo", run: undo },
    });
    await vi.advanceTimersByTimeAsync(3000);
    showToast({ title: "Second", message: "", onDismiss: secondSave });
    first.close(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(undo).toHaveBeenCalledOnce();
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).toHaveBeenCalledOnce();
    expect(getToasts()).toHaveLength(0);
  });

  it("keeps a 311 failure visible with a red-cross icon and a retry message", async () => {
    const toast = show311ErrorToast();
    expect(toast.icon).toBe("circle-xmark");
    expect(toast.tone).toBe("error");
    expect(toast.message).toBe(
      "We couldn't complete the 311 submission. Please try again.",
    );
    expect(toast.message).not.toContain("Can't");
    await vi.advanceTimersByTimeAsync(60000);
    expect(getToasts()).toContain(toast);
    toast.close();
    expect(getToasts()).not.toContain(toast);
  });

  it("uses the approved 311 copy and a shareable In progress destination", () => {
    const toast = show311SuccessToast();
    expect(toast.title).toBe("Great work!");
    expect(toast.message + toast.link.label).toBe(
      "We've submitted the ticket. Check its status under in progress",
    );
    expect(toast.link.href).toBe("/today?filter=in_progress");
    expect(toast.action).toBeUndefined();
  });
});
