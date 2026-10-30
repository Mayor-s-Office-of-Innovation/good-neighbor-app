import { showInlineError } from "../components/error-notice.js";
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
 * @property {Element | null} [target]
 * @property {boolean} [warning]
 * @property {string} [key] Stable operation identity for deduplication.
 */
import { t } from "../i18n/i18n.js";
import { getHealthState } from "../services/backend-health.js";

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
      activateNext();
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
  const key =
    options.key ||
    (!options.action && !options.onDismiss
      ? `${options.title}:${options.message}`
      : undefined);
  const existing =
    key && toasts.find((toast) => toast.key === key && !toast.onDismiss);
  if (existing) return existing;
  const toast = createToast({ ...options, key });
  // Undo callbacks commit data on dismissal. Their lifecycle is unchanged.
  if (!options.onDismiss) toast.pause("queue");
  toasts.push(toast);
  activateNext();
  emit();
  if (options.onDismiss) toast.resume();
  return toast;
}

function activateNext() {
  toasts.find((toast) => !toast.onDismiss)?.resume("queue");
}

export function getToasts() {
  const first = toasts.find((toast) => !toast.onDismiss);
  return toasts.filter((toast) => toast.onDismiss || toast === first);
}

/** @param {() => void} listener */
export function onToastsChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @param {ToastOptions} options */
export function showOperationError(options) {
  const local = showInlineError(options.message, {
    title: options.title,
    target: options.target,
    key: options.key || options.title,
    retry: options.action?.run,
    retryLabel: options.action?.label,
    duration:
      options.duration && options.duration > 0 ? options.duration : undefined,
    warning: options.warning || options.tone === "info",
  });
  return local || showToast({ ...options, key: options.key });
}

/**
 * @param {string} [serviceRequestNumber]
 * @param {string} [title] the card's title, so a toast that lands after the
 *   user has moved on to other cards still says which ticket this is
 */
/**
 * The toast for an accepted "File 311 ticket" tap: the ticket number when it
 * was filed in the request, "Filing with 311" when it was queued.
 * @param {import("../domain/task-actions.js").TaskActionState} task
 * @param {string} [title] the card's title
 */
export function show311FilingToast(task, title = "") {
  return show311QueuedToast(title);
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

export function show311ErrorToast(target = null) {
  return showOperationError({
    target,
    title: t("toast.ticketFailed.title"),
    message: t("toast.ticketFailed.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

/** @param {() => void} [retry] */
export function showActionSaveErrorToast(retry, target = null) {
  return showOperationError({
    warning: true,
    duration: 0,
    ...(retry
      ? { duration: 0, action: { label: t("common.retry"), run: retry } }
      : {}),
    target,
    title: t("toast.actionSaveError.title"),
    message: t("toast.actionSaveError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showAnswerSaveErrorToast() {
  return showOperationError({
    title: t("toast.answerSaveError.title"),
    message: t("toast.answerSaveError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showDeletionRefreshToast() {
  return showOperationError({
    duration: 5000,
    title: t("toast.deletionRefresh.title"),
    message: t("toast.deletionRefresh.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showDeleteErrorToast() {
  return showOperationError({
    title: t("toast.deleteError.title"),
    message: t("toast.deleteError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditErrorToast() {
  return showOperationError({
    warning: true,
    duration: 0,
    title: t("toast.editError.title"),
    message: t("toast.editError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditRefreshErrorToast() {
  return showOperationError({
    duration: 5000,
    title: t("toast.editRefreshError.title"),
    message: t("toast.editRefreshError.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showReanalysisErrorToast() {
  return showOperationError({
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
  return showOperationError({
    warning: true,
    duration: 0,
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
  return showOperationError({
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
  return showOperationError({
    title: t("toast.siteAdminError.title"),
    message: t("toast.siteAdminError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteSwitchErrorToast() {
  return showOperationError({
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
  return showOperationError({
    title: t("toast.siteCatalogError.title"),
    message: t("toast.siteCatalogError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteSwitchBlockedToast() {
  return showOperationError({
    title: t("toast.siteSwitchBlocked.title"),
    message: t("toast.siteSwitchBlocked.message"),
    icon: "circle-info",
    tone: "info",
  });
}

export function showLanguageErrorToast() {
  return showOperationError({
    title: t("toast.languageError.title"),
    message: t("toast.languageError.message"),
    icon: "triangle-exclamation",
    tone: "error",
  });
}
