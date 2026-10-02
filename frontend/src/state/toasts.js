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

/** @param {string} [serviceRequestNumber] */
export function show311SuccessToast(serviceRequestNumber = "") {
  return showToast({
    title: "Ticket filed",
    message: serviceRequestNumber
      ? `311 ticket #${serviceRequestNumber}`
      : "311 ticket filed",
    icon: "circle-check",
    tone: "success",
  });
}

export function show311ErrorToast() {
  return showToast({
    title: "Ticket filing failed",
    message: "We could not file your 311 ticket. Please try again later.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditSavedToast() {
  return showToast({
    title: "Edits saved",
    message: "The issue description has been successfully updated",
    icon: "circle-check",
    tone: "success",
  });
}

export function showActionSaveErrorToast() {
  return showToast({
    title: "Save failed",
    message: "We couldn't save your action. Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showAnswerSaveErrorToast() {
  return showToast({
    title: "Save failed",
    message: "We couldn't save your answer. Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showDeletionRefreshToast() {
  return showToast({
    title: "Deletion saved",
    message: "Please reload the page.",
    icon: "circle-info",
    tone: "info",
  });
}

export function showSavedForLaterToast() {
  return showToast({
    title: "Saved for later",
    message: "You're offline. We'll sync this later.",
    icon: "circle-info",
    tone: "info",
  });
}

export function showOfflinePhotosToast() {
  return showToast({
    title: "You're offline",
    message: "Your photos are saved. We'll retry later.",
    icon: "circle-info",
    tone: "info",
  });
}

export function showDeleteErrorToast() {
  return showToast({
    title: "Item could not be deleted",
    message: "We could not delete your item. Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditErrorToast() {
  return showToast({
    title: "Edits could not be saved",
    message: "Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showEditRefreshErrorToast() {
  return showToast({
    title: "Edits saved but could not refresh",
    message: "Please reload your page.",
    icon: "circle-info",
    tone: "info",
  });
}

export function showReanalysisErrorToast() {
  return showToast({
    title: "Changes could not be analyzed",
    message: "We were unable to re-analyze this description.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showTaskUpdateErrorToast() {
  return showToast({
    title: "Failed to save",
    message: "Please try again later.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showFeedbackErrorToast() {
  return showToast({
    title: "Feedback failed to send",
    message: "Please try again later.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showFeedbackSuccessToast() {
  return showToast({
    title: "Feedback sent",
    message: "Thanks for sharing!",
    icon: "circle-check",
    tone: "success",
  });
}

export function showSiteAdminErrorToast() {
  return showToast({
    title: "Save failed",
    message: "Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteAdminSuccessToast() {
  return showToast({
    title: "Changes saved",
    message: "Your site administration changes have been saved",
    icon: "circle-check",
    tone: "success",
  });
}

export function showSiteSwitchErrorToast() {
  return showToast({
    title: "Could not switch sites",
    message: "Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteCatalogErrorToast() {
  return showToast({
    title: "Sites could not be loaded",
    message: "Please try again.",
    icon: "triangle-exclamation",
    tone: "error",
  });
}

export function showSiteSwitchBlockedToast() {
  return showToast({
    title: "Site switch unavailable",
    message: "Wait for your check to finish analyzing, then try again.",
    icon: "circle-info",
    tone: "info",
  });
}

export function showSiteSwitchSuccessToast() {
  return showToast({
    title: "Successfully switched sites",
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
