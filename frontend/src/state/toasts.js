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
  let remaining = options.duration ?? 10000;
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

export function show311SuccessToast() {
  return showToast({
    title: "Great work!",
    message: "We've submitted the ticket. Check its status under ",
    icon: "circle-check",
    tone: "success",
    link: { label: "in progress", href: "/today?filter=in_progress" },
  });
}

export function show311ErrorToast() {
  return showToast({
    title: "Couldn't submit ticket",
    message: "We couldn't complete the 311 submission. Please try again.",
    icon: "circle-xmark",
    tone: "error",
    duration: 0,
  });
}
