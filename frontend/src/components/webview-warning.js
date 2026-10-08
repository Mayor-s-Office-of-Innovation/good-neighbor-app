import { escapeUrlForPlatform } from "../services/browser-context.js";
import { reportClientEvent } from "../services/error-report.js";
import { escapeAttr, escapeHtml } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

/** @param {HTMLElement} root */
export function showWebviewWarning(root) {
  if (!root.isConnected || root.querySelector(".webview-banner")) return;
  reportClientEvent("in_app_browser", "in-app webview detected at boot", {});
  const host = root.querySelector(".app__main") || root;
  host.insertAdjacentHTML(
    "afterbegin",
    `<div class="webview-banner" role="status">
      <p><strong>${escapeHtml(t("webview.banner.title"))}</strong> ${escapeHtml(t("webview.banner.message"))}</p>
      <button class="webview-banner__open" type="button">${escapeHtml(t("webview.banner.open"))}</button>
      <button class="webview-banner__close" type="button" aria-label="${escapeAttr(t("webview.banner.dismiss.aria"))}">✕</button>
    </div>`,
  );
  root.querySelector(".webview-banner__open")?.addEventListener("click", () => {
    const url = escapeUrlForPlatform();
    if (url) window.open(url, "_blank", "noopener");
  });
  root
    .querySelector(".webview-banner__close")
    ?.addEventListener("click", () =>
      root.querySelector(".webview-banner")?.remove(),
    );
}
