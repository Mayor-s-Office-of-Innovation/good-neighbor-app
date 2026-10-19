/*
  <install-prompt> — the Add-to-Home-Screen banner. Lazy-loaded by app-root
  when services/install-prompt.js says an offer is due, mounted once per shell
  render above <main>, and shown on the home hub (/today) only so it never
  sits on top of a check or report flow. Chromium gets an Install button that
  replays the held beforeinstallprompt; iOS Safari gets the Share-sheet
  instruction. Either close path records a dismissal (two-week snooze).
*/
import { currentRoute, onRouteChange } from "../router.js";
import { trackEvent } from "../services/analytics.js";
import {
  dismissInstall,
  hasHeldPrompt,
  installMethod,
  onInstallAvailable,
  promptInstall,
} from "../services/install-prompt.js";
import { escapeAttr, escapeHtml } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import "./install-prompt.css";

const HOME = "/today";

export class InstallPrompt extends HTMLElement {
  /** @type {"prompt" | "ios" | null} */
  _method = null;
  _shown = false;

  connectedCallback() {
    this.hidden = true;
    this._method = installMethod();
    this._unsubRoute = onRouteChange(() => this._syncVisibility());
    if (this._method === "ios") {
      this._render();
    } else if (this._method === "prompt") {
      // Render only once the browser has actually handed us a prompt.
      this._unsubAvailable = onInstallAvailable(() => {
        if (hasHeldPrompt()) this._render();
      });
    }
  }

  disconnectedCallback() {
    this._unsubRoute?.();
    this._unsubAvailable?.();
    this._unsubRoute = this._unsubAvailable = undefined;
  }

  _render() {
    if (this.querySelector(".install-banner")) return;
    const ios = this._method === "ios";
    this.innerHTML = `<div class="install-banner" role="region" aria-label="${escapeAttr(t("install.banner.aria"))}">
      <img class="install-banner__icon" src="/img/icon-192.png" alt="" width="40" height="40" />
      <p><strong>${escapeHtml(t("install.banner.title"))}</strong> ${escapeHtml(t(ios ? "install.banner.ios" : "install.banner.message"))}</p>
      ${ios ? "" : `<button class="install-banner__install" type="button">${escapeHtml(t("install.banner.install"))}</button>`}
      <button class="install-banner__close" type="button" aria-label="${escapeAttr(t("install.banner.dismiss.aria"))}">✕</button>
    </div>`;
    this.querySelector(".install-banner__install")?.addEventListener(
      "click",
      () => void this._install(),
    );
    this.querySelector(".install-banner__close")?.addEventListener(
      "click",
      () => this._dismiss(),
    );
    this._syncVisibility();
  }

  _syncVisibility() {
    const show =
      currentRoute() === HOME && Boolean(this.querySelector(".install-banner"));
    this.hidden = !show;
    if (show && !this._shown) {
      this._shown = true;
      void trackEvent("install_prompt_shown", { method: this._method });
    }
  }

  async _install() {
    const outcome = await promptInstall();
    void trackEvent("install_prompt_answered", {
      method: this._method,
      outcome: outcome ?? "unavailable",
    });
    if (outcome === "accepted") {
      this.remove();
      return;
    }
    // Declined in the browser sheet, or the prompt was already spent: treat
    // it as "not now" rather than leaving a dead button on screen.
    this._dismiss(false);
  }

  /** @param {boolean} [track] */
  _dismiss(track = true) {
    dismissInstall();
    if (track)
      void trackEvent("install_prompt_dismissed", { method: this._method });
    this.remove();
  }
}

if (!customElements.get("install-prompt"))
  customElements.define("install-prompt", InstallPrompt);
