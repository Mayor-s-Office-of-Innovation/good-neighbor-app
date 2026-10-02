import { escapeUrlForPlatform } from "../services/browser-context.js";
import { reportClientEvent } from "../services/error-report.js";

/** @param {HTMLElement} root */
export function showWebviewWarning(root) {
  if (!root.isConnected || root.querySelector(".webview-banner")) return;
  reportClientEvent("in_app_browser", "in-app webview detected at boot", {});
  const host = root.querySelector(".app__main") || root;
  host.insertAdjacentHTML(
    "afterbegin",
    `<div class="webview-banner" role="status">
      <p><strong>Camera may not open here.</strong> You're inside another app's
      browser. Open in your browser instead for the camera to work.</p>
      <button class="webview-banner__open" type="button">Open in browser</button>
      <button class="webview-banner__close" type="button" aria-label="Dismiss">✕</button>
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
