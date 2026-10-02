import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getToasts,
  showToast,
  show311SuccessToast,
  show311ErrorToast,
  showActionSaveErrorToast,
  showAnswerSaveErrorToast,
  showDeletionRefreshToast,
  showEditSavedToast,
  showSavedForLaterToast,
  showOfflinePhotosToast,
  showDeleteErrorToast,
  showEditErrorToast,
  showEditRefreshErrorToast,
  showReanalysisErrorToast,
  showTaskUpdateErrorToast,
  showFeedbackErrorToast,
  showFeedbackSuccessToast,
  showSiteAdminErrorToast,
  showSiteAdminSuccessToast,
  showSiteSwitchErrorToast,
  showSiteSwitchSuccessToast,
  queueSiteSwitchSuccessToast,
  showQueuedSiteSwitchSuccessToast,
} from "./toasts.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  getToasts().forEach((toast) => toast.close(true));
  vi.unstubAllGlobals();
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
    await vi.advanceTimersByTimeAsync(1000);
    showToast({ title: "Second", message: "", onDismiss: secondSave });
    first.close(true);
    await vi.advanceTimersByTimeAsync(3500);
    expect(undo).toHaveBeenCalledOnce();
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).toHaveBeenCalledOnce();
    expect(getToasts()).toHaveLength(0);
  });

  it("uses the approved 311 failure copy and expires after 3.5 seconds", async () => {
    const toast = show311ErrorToast();
    expect(toast.title).toBe("Ticket filing failed");
    expect(toast.icon).toBe("triangle-exclamation");
    expect(toast.tone).toBe("error");
    expect(toast.message).toBe(
      "We could not file your 311 ticket. Please try again later.",
    );
    await vi.advanceTimersByTimeAsync(3499);
    expect(getToasts()).toContain(toast);
    await vi.advanceTimersByTimeAsync(1);
    expect(getToasts()).not.toContain(toast);
  });

  it("uses the approved 311 success copy", () => {
    const toast = show311SuccessToast("LOCAL-SR-000001");
    expect(toast.title).toBe("Ticket filed");
    expect(toast.message).toBe("311 ticket #LOCAL-SR-000001");
    expect(toast.action).toBeUndefined();
  });

  it("defines the standardized edit, save-failure, and information variants", () => {
    expect(showEditSavedToast()).toMatchObject({
      title: "Edits saved",
      message: "The issue description has been successfully updated",
      tone: "success",
    });
    expect(showActionSaveErrorToast()).toMatchObject({
      title: "Save failed",
      message: "We couldn't save your action. Please try again.",
      tone: "error",
    });
    expect(showAnswerSaveErrorToast()).toMatchObject({
      title: "Save failed",
      message: "We couldn't save your answer. Please try again.",
      tone: "error",
    });
    expect(showDeletionRefreshToast()).toMatchObject({
      title: "Deletion saved",
      message: "Please reload the page.",
      tone: "info",
    });
    expect(showSavedForLaterToast()).toMatchObject({
      title: "Saved for later",
      message: "You're offline. We'll sync this later.",
      tone: "info",
    });
    expect(showOfflinePhotosToast()).toMatchObject({
      title: "You're offline",
      message: "Your photos are saved. We'll retry later.",
      tone: "info",
    });
  });

  it("defines the remaining standardized action outcomes", () => {
    expect(showDeleteErrorToast()).toMatchObject({
      title: "Item could not be deleted",
      message: "We could not delete your item. Please try again.",
      tone: "error",
    });
    expect(showEditErrorToast()).toMatchObject({
      title: "Edits could not be saved",
      message: "Please try again.",
      tone: "error",
    });
    expect(showEditRefreshErrorToast()).toMatchObject({
      title: "Edits saved but could not refresh",
      message: "Please reload your page.",
      tone: "info",
    });
    expect(showReanalysisErrorToast()).toMatchObject({
      title: "Changes could not be analyzed",
      message: "We were unable to re-analyze this description.",
      tone: "error",
    });
    expect(showTaskUpdateErrorToast()).toMatchObject({
      title: "Failed to save",
      message: "Please try again later.",
      tone: "error",
    });
    expect(showFeedbackErrorToast()).toMatchObject({
      title: "Feedback failed to send",
      message: "Please try again later.",
      tone: "error",
    });
    expect(showFeedbackSuccessToast()).toMatchObject({
      title: "Feedback sent",
      message: "Thanks for sharing!",
      tone: "success",
    });
    expect(showSiteAdminErrorToast()).toMatchObject({
      title: "Save failed",
      message: "Please try again.",
      tone: "error",
    });
    expect(showSiteAdminSuccessToast()).toMatchObject({
      title: "Changes saved",
      message: "Your site administration changes have been saved",
      tone: "success",
    });
    expect(showSiteSwitchErrorToast()).toMatchObject({
      title: "Could not switch sites",
      message: "Please try again.",
      tone: "error",
    });
    expect(showSiteSwitchSuccessToast()).toMatchObject({
      title: "Successfully switched sites",
      message: "",
      tone: "success",
    });
  });

  it("carries the site-switch success toast across one page reload", () => {
    const values = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    });

    expect(queueSiteSwitchSuccessToast()).toBe(true);
    expect(showQueuedSiteSwitchSuccessToast()).toBe(true);
    expect(getToasts().at(-1)?.title).toBe("Successfully switched sites");
    expect(showQueuedSiteSwitchSuccessToast()).toBe(false);
  });
});
