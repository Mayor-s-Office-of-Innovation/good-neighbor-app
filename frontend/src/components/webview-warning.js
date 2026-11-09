import { escapeUrlForPlatform } from "../services/browser-context.js";
import { reportClientEvent } from "../services/error-report.js";
import { escapeAttr, escapeHtml } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

/**
 * No setup component, dismiss action, or automatic navigation: a detected
 * webview must not consume an invitation in its separate storage container.
 * @param {HTMLElement} root
 */
export function showWebviewGate(root) {
  root.innerHTML = `<main class="app__main" id="webview-gate">
    <section class="login" aria-labelledby="webview-title">
      <div class="login__panel">
        <h1 id="webview-title">${escapeHtml(t("webview.gate.title"))}</h1>
        <p>${escapeHtml(t("webview.gate.message"))}</p>
        <p>${escapeHtml(t("webview.gate.instructions"))}</p>
        <button id="webview-copy" class="btn-ink" type="button">${escapeHtml(t("webview.gate.copy"))}</button>
        <p id="webview-copy-status" role="status"></p>
        <wa-textarea id="webview-link" label="${escapeAttr(t("webview.gate.link"))}" readonly rows="3" hidden></wa-textarea>
      </div>
    </section>
  </main>`;
  root.querySelector("#webview-copy")?.addEventListener("click", async () => {
    // Read on each tap so fragment navigation in the email app stays intact.
    // Never send this URL (which may contain invitation secrets) to telemetry.
    const url = location.href;
    const status = root.querySelector("#webview-copy-status");
    try {
      await navigator.clipboard.writeText(url);
      if (status) status.textContent = t("webview.gate.copied");
    } catch {
      if (status) status.textContent = t("webview.gate.manualCopy");
      const field =
        /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default | null} */ (
          root.querySelector("#webview-link")
        );
      if (field) {
        field.value = url;
        field.hidden = false;
        await field.updateComplete;
        field.focus();
        field.select();
      }
    }
  });
}

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
