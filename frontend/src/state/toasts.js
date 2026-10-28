/**
 * App-lifetime notifications. Timers survive route changes; nothing is persisted.
 * @typedef {object} ToastOptions
 * @property {string} title
 * @property {string} message
 * @property {string} [icon]
 * @property {string} [tone]
 * @property {{label: string, href: string}} [link]
 * @property {{label: string, run: () => void}} [action]
 * @property {() => void} [onDismiss]
 * @property {number} [duration]
 * @property {boolean} [focusAction]
 */
import { t } from "../i18n/i18n.js";
import { getHealthState } from "../services/backend-health.js";
import {
  filing311State,
  submitted311ServiceRequestNumber,
} from "../domain/task-actions.js";

/** @type {Set<() => void>} */
const listeners = new Set();
/** @type {ReturnType<typeof createToast>[]} */
const toasts = [];

function emit() {
  listeners.forEach((listener) => listener());
}

/** @param {ToastOptions} options */
function createToast(options) {
  let remaining = options.duration ?? 3500;
  let started = 0;
  let closed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const pauses = new Set();
  const toast = {
    ...options,
    close(action = false) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      toasts.splice(toasts.indexOf(toast), 1);
      // Remove the Undo affordance before saving can begin.
      emit();
      if (action) options.action?.run();
      else options.onDismiss?.();
    },
    pause(reason = "interaction") {
      if (closed || pauses.has(reason)) return;
      if (!pauses.size && timer !== undefined) {
        remaining = Math.max(0, remaining - (Date.now() - started));
        clearTimeout(timer);
        timer = undefined;
      }
      pauses.add(reason);
    },
    resume(reason = "interaction") {
      pauses.delete(reason);
      if (
        closed ||
        pauses.size ||
        timer !== undefined ||
        options.duration === 0
      )
        return;
      started = Date.now();
      timer = setTimeout(() => toast.close(), remaining);
    },
  };
  return toast;
}

/** @param {ToastOptions} options */
export function showToast(options) {
  const toast = createToast(options);
  toasts.push(toast);
  emit();
  toast.resume();
  return toast;
}

export function getToasts() {
  return [...toasts];
}

/** @param {() => void} listener */
export function onToastsChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * @param {string} [serviceRequestNumber]
 * @param {string} [title] the card's title, so a toast that lands after the
 *   user has moved on to other cards still says which ticket this is
 */
export function show311SuccessToast(serviceRequestNumber = "", title = "") {
  const number = serviceRequestNumber;
  return showToast({
    title: t("toast.ticketFiled.title"),
    message: title
      ? number
        ? t("toast.ticketFiled.messageFor", { number, title })
        : t("toast.ticketFiled.messageNoNumberFor", { title })
      : number
        ? t("toast.ticketFiled.message", { number })
        : t("toast.ticketFiled.messageNoNumber"),
    icon: "circle-check",
    tone: "success",
  });
}

/**
 * The toast for an accepted "File 311 ticket" tap: the ticket number when it
 * was filed in the request, "Filing with 311" when it was queued.
 * @param {import("../domain/task-actions.js").TaskActionState} task
 * @param {string} [title] the card's title
 */
export function show311FilingToast(task, title = "") {
  return filing311State(task) === "queued"
    ? show311QueuedToast(title)
    : show311SuccessToast(submitted311ServiceRequestNumber(task), title);
}

/**
 * The tap was accepted and the ticket is filing in the background.
 * @param {string} [title] the card's title
 */
export function show311QueuedToast(title = "") {
  return showToast({
    title: t("toast.ticketQueued.title"),
    message: title
      ? t("toast.ticketQueued.messageFor", { title })
      : t("toast.ticketQueued.message"),
    icon: "paper-plane",
    tone: "info",
  });
}

export function showComplaintLoggedToast() {
  return showToast({
    title: t("complaints.toast.logged"),
    message: "",
    icon: "circle-check",
    tone: "success",
  });
}

export function show311ErrorToast() {
  return showToast({
    title: t("toast.ticketFailed.title"),
    message: t("toast.ticketFailed.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditSavedToast() {
  return showToast({
    title: t("toast.editSaved.title"),
    message: t("toast.editSaved.message"),
    icon: "circle-check",
    tone: "success",
  });
}

/** @param {() => void} [retry] */
export function showActionSaveErrorToast(retry) {
  return showToast({
    ...(retry
      ? { duration: 0, action: { label: t("common.retry"), run: retry } }
      : {}),
    title: t("toast.actionSaveError.title"),
    message: t("toast.actionSaveError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showAnswerSaveErrorToast() {
  return showToast({
    title: t("toast.answerSaveError.title"),
    message: t("toast.answerSaveError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showDeletionRefreshToast() {
  return showToast({
    title: t("toast.deletionRefresh.title"),
    message: t("toast.deletionRefresh.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showSavedForLaterToast() {
  return showToast({
    title: t("toast.savedForLater.title"),
    message: t("toast.savedForLater.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showOfflinePhotosToast() {
  return showToast({
    title: t("toast.offlinePhotos.title"),
    message: t("toast.offlinePhotos.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showDeleteErrorToast() {
  return showToast({
    title: t("toast.deleteError.title"),
    message: t("toast.deleteError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditErrorToast() {
  return showToast({
    title: t("toast.editError.title"),
    message: t("toast.editError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditRefreshErrorToast() {
  return showToast({
    title: t("toast.editRefreshError.title"),
    message: t("toast.editRefreshError.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showReanalysisErrorToast() {
  return showToast({
    title: t("toast.reanalysisError.title"),
    message: t("toast.reanalysisError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

/** @param {unknown} [error] */
/**
 * @param {unknown} [error]
 * @param {() => void} [retry] offered as the toast's action; the toast then
 *   stays until dismissed
 */
export function showTaskUpdateErrorToast(error, retry) {
  const saved =
    error &&
    typeof error === "object" &&
    "body" in error &&
    error.body &&
    typeof error.body === "object" &&
    "updateSaved" in error.body &&
    error.body.updateSaved === true;
  const key = saved ? "toast.cityUpdateError" : "toast.taskUpdateError";
  return showToast({
    ...(retry
      ? { duration: 0, action: { label: t("common.retry"), run: retry } }
      : {}),
    title: t(`${key}.title`),
    message: t(`${key}.message`),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showFeedbackErrorToast() {
  return showToast({
    title: t("toast.feedbackError.title"),
    message: t("toast.feedbackError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showFeedbackSuccessToast() {
  return showToast({
    title: t("toast.feedbackSuccess.title"),
    message: t("toast.feedbackSuccess.message"),
    icon: "circle-check",
    tone: "success",
  });
}

export function showSiteAdminErrorToast() {
  return showToast({
    title: t("toast.siteAdminError.title"),
    message: t("toast.siteAdminError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteAdminSuccessToast() {
  return showToast({
    title: t("toast.siteAdminSuccess.title"),
    message: t("toast.siteAdminSuccess.message"),
    icon: "circle-check",
    tone: "success",
  });
}

export function showSiteSwitchErrorToast() {
  return showToast({
    title: t("toast.siteSwitchError.title"),
    message: t("toast.siteSwitchError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

/**
 * Skipped while the API is unreachable: the outage already has its own
 * "You're offline" toast (connection-status.js), and every home load would
 * otherwise add a second error for the same cause. Returns null when skipped.
 */
export function showSiteCatalogErrorToast() {
  if (getHealthState() === "outage") return null;
  return showToast({
    title: t("toast.siteCatalogError.title"),
    message: t("toast.siteCatalogError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteSwitchBlockedToast() {
  return showToast({
    title: t("toast.siteSwitchBlocked.title"),
    message: t("toast.siteSwitchBlocked.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showLanguageErrorToast() {
  return showToast({
    title: t("toast.languageError.title"),
    message: t("toast.languageError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteSwitchSuccessToast() {
  return showToast({
    title: t("toast.siteSwitchSuccess.title"),
    message: "",
    icon: "circle-check",
    tone: "success",
  });
}

const SITE_SWITCH_SUCCESS_KEY = "gnp:site-switch-success";

export function queueSiteSwitchSuccessToast() {
  try {
    sessionStorage.setItem(SITE_SWITCH_SUCCESS_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function showQueuedSiteSwitchSuccessToast() {
  try {
    if (sessionStorage.getItem(SITE_SWITCH_SUCCESS_KEY) !== "1") return false;
    sessionStorage.removeItem(SITE_SWITCH_SUCCESS_KEY);
    showSiteSwitchSuccessToast();
    return true;
  } catch {
    return false;
  }
}
