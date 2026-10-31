import { onHealthChange } from "../services/backend-health.js";
import "./error-notice.css";
import { t } from "../i18n/i18n.js";

/** Display an error beside the live operation, never discard the user's draft.
 * @param {string} message
 * @param {{title?: string, target?: Element | null, key?: string, duration?: number, warning?: boolean, retryLabel?: string, retry?: () => unknown, retryAvailable?: () => boolean}} [options]
 */
export function showInlineError(message, options = {}) {
  if (
    typeof document === "undefined" ||
    typeof document.querySelector !== "function"
  )
    return null;
  const modal = [...(document.querySelectorAll?.("dialog:modal") || [])].at(-1);
  const target =
    options.target ||
    modal?.querySelector("form") ||
    modal ||
    document.querySelector(
      "dialog[open] form, dialog[open], #view > *, admin-app main, admin-app, admin-analytics",
    );
  if (!target?.isConnected) return null;
  const key = options.key || "operation";
  const previous = [...target.querySelectorAll("[data-operation-error]")].find(
    (node) => node.getAttribute("data-operation-error") === key,
  );
  previous?.remove();
  const notice = document.createElement("div");
  notice.className = "app-error app-error--panel";
  notice.dataset.operationError = key;
  notice.setAttribute("role", "alert");
  if (options.warning) notice.classList.add("app-error--warning");
  if (options.title) {
    const title = document.createElement("strong");
    title.textContent = options.title;
    notice.append(title, document.createTextNode(" "));
  }
  const copy = document.createElement("span");
  copy.textContent = message;
  notice.append(copy);
  let unsubscribe;
  if (options.retry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-outline btn-outline--sm";
    retry.textContent = options.retryLabel || t("common.retry");
    let retrying = false;
    const refresh = () => {
      if (!notice.isConnected) {
        unsubscribe?.();
        return;
      }
      retry.disabled =
        retrying ||
        (options.retryAvailable ? !options.retryAvailable() : false);
    };
    retry.disabled =
      retrying || (options.retryAvailable ? !options.retryAvailable() : false);
    if (options.retryAvailable) unsubscribe = onHealthChange(refresh);
    retry.addEventListener("click", async () => {
      if (
        retry.disabled ||
        (options.retryAvailable && !options.retryAvailable())
      )
        return;
      retrying = true;
      retry.disabled = true;
      try {
        await options.retry?.();
      } catch {
        /* The operation retains its contextual failure state. */
      } finally {
        retrying = false;
        refresh();
      }
    });
    notice.append(retry);
  }
  target.prepend(notice);
  decorateError(notice);
  if (options.duration) setTimeout(() => notice.remove(), options.duration);
  return {
    close: () => {
      unsubscribe?.();
      notice.remove();
    },
  };
}

/** Standardize authored and dynamically inserted errors without replacing their controls.
 * @param {Element} element
 */
export function decorateError(element) {
  if (
    !element.textContent?.trim() ||
    element.closest("app-toasts, .app-load-error") ||
    element.matches("[data-notice-decorated]")
  )
    return;
  element.classList.add("app-error");
  if (!element.hasAttribute("role")) element.setAttribute("role", "alert");
  element.setAttribute("data-notice-decorated", "");
}

const selector =
  '[role="alert"], .error, .login__error, .analysis-dialog__error, .task-update__error, .care-error, .site-admin-form-error, .logout-dialog__error';
/** Enhance error regions on both applications, including asynchronous form errors. */
export function startErrorPresentation() {
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  )
    return;
  const apply = (/** @type {Element} */ root) => {
    if (root.matches(selector)) decorateError(root);
    root.querySelectorAll(selector).forEach(decorateError);
  };
  apply(document.body);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && record.target.matches(selector))
        decorateError(record.target);
      for (const node of record.addedNodes)
        if (node instanceof Element) apply(node);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => observer.disconnect();
}
