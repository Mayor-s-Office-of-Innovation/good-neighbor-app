import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n/i18n.js";
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
  showSiteCatalogErrorToast,
  showSiteSwitchBlockedToast,
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
    expect(toast.title).toBe(t("toast.ticketFailed.title"));
    expect(toast.icon).toBe("triangle-exclamation");
    expect(toast.tone).toBe("error");
    expect(toast.message).toBe(t("toast.ticketFailed.message"));
    await vi.advanceTimersByTimeAsync(3499);
    expect(getToasts()).toContain(toast);
    await vi.advanceTimersByTimeAsync(1);
    expect(getToasts()).not.toContain(toast);
  });

  it("uses the approved 311 success copy", () => {
    const toast = show311SuccessToast("LOCAL-SR-000001");
    expect(toast.title).toBe(t("toast.ticketFiled.title"));
    expect(toast.message).toBe(
      t("toast.ticketFiled.message", { number: "LOCAL-SR-000001" }),
    );
    expect(toast.action).toBeUndefined();
  });

  it("defines the standardized edit, save-failure, and information variants", () => {
    expect(showEditSavedToast()).toMatchObject({
      title: t("toast.editSaved.title"),
      message: t("toast.editSaved.message"),
      tone: "success",
    });
    expect(showActionSaveErrorToast()).toMatchObject({
      title: t("toast.actionSaveError.title"),
      message: t("toast.actionSaveError.message"),
      tone: "error",
    });
    expect(showAnswerSaveErrorToast()).toMatchObject({
      title: t("toast.answerSaveError.title"),
      message: t("toast.answerSaveError.message"),
      tone: "error",
    });
    expect(showDeletionRefreshToast()).toMatchObject({
      title: t("toast.deletionRefresh.title"),
      message: t("toast.deletionRefresh.message"),
      tone: "info",
    });
    expect(showSavedForLaterToast()).toMatchObject({
      title: t("toast.savedForLater.title"),
      message: t("toast.savedForLater.message"),
      tone: "info",
    });
    expect(showOfflinePhotosToast()).toMatchObject({
      title: t("toast.offlinePhotos.title"),
      message: t("toast.offlinePhotos.message"),
      tone: "info",
    });
  });

  it("defines the remaining standardized action outcomes", () => {
    expect(showDeleteErrorToast()).toMatchObject({
      title: t("toast.deleteError.title"),
      message: t("toast.deleteError.message"),
      tone: "error",
    });
    expect(showEditErrorToast()).toMatchObject({
      title: t("toast.editError.title"),
      message: t("toast.editError.message"),
      tone: "error",
    });
    expect(showEditRefreshErrorToast()).toMatchObject({
      title: t("toast.editRefreshError.title"),
      message: t("toast.editRefreshError.message"),
      tone: "info",
    });
    expect(showReanalysisErrorToast()).toMatchObject({
      title: t("toast.reanalysisError.title"),
      message: t("toast.reanalysisError.message"),
      tone: "error",
    });
    expect(showTaskUpdateErrorToast()).toMatchObject({
      title: t("toast.taskUpdateError.title"),
      message: t("toast.taskUpdateError.message"),
      tone: "error",
    });
    expect(showFeedbackErrorToast()).toMatchObject({
      title: t("toast.feedbackError.title"),
      message: t("toast.feedbackError.message"),
      tone: "error",
    });
    expect(showFeedbackSuccessToast()).toMatchObject({
      title: t("toast.feedbackSuccess.title"),
      message: t("toast.feedbackSuccess.message"),
      tone: "success",
    });
    expect(showSiteAdminErrorToast()).toMatchObject({
      title: t("toast.siteAdminError.title"),
      message: t("toast.siteAdminError.message"),
      tone: "error",
    });
    expect(showSiteAdminSuccessToast()).toMatchObject({
      title: t("toast.siteAdminSuccess.title"),
      message: t("toast.siteAdminSuccess.message"),
      tone: "success",
    });
    expect(showSiteSwitchErrorToast()).toMatchObject({
      title: t("toast.siteSwitchError.title"),
      message: t("toast.siteSwitchError.message"),
      tone: "error",
    });
    expect(showSiteCatalogErrorToast()).toMatchObject({
      title: t("toast.siteCatalogError.title"),
      message: t("toast.siteCatalogError.message"),
      tone: "error",
    });
    expect(showSiteSwitchBlockedToast()).toMatchObject({
      title: t("toast.siteSwitchBlocked.title"),
      message: t("toast.siteSwitchBlocked.message"),
      tone: "info",
    });
    expect(showSiteSwitchSuccessToast()).toMatchObject({
      title: t("toast.siteSwitchSuccess.title"),
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
