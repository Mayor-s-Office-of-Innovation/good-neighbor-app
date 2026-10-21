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
  onAppInstalled,
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
  /** an Install attempt is awaiting the browser's dialog */
  _busy = false;

  connectedCallback() {
    this.hidden = true;
    this._method = installMethod();
    this._unsubRoute = onRouteChange(() => this._syncVisibility());
    // Installed by any route (the browser's own menu included): the offer is
    // moot, and a click on the stale button would read as a dismissal.
    this._unsubInstalled = onAppInstalled(() => this.remove());
    // The shell re-renders only #view on a language switch; this element
    // sits outside it, so it re-translates itself.
    this._onLocaleChange = () => {
      if (this.querySelector(".install-banner")) this._render(true);
    };
    window.addEventListener("localechange", this._onLocaleChange);
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
    this._unsubInstalled?.();
    this._unsubRoute = this._unsubAvailable = this._unsubInstalled = undefined;
    if (this._onLocaleChange)
      window.removeEventListener("localechange", this._onLocaleChange);
    this._onLocaleChange = undefined;
  }

  /** @param {boolean} [force] rebuild existing markup (language switch) */
  _render(force = false) {
    if (!force && this.querySelector(".install-banner")) return;
    const ios = this._method === "ios";
    this.innerHTML = `<div class="install-banner" role="region" aria-label="${escapeAttr(t("install.banner.aria"))}">
      <img class="install-banner__icon" src="/img/icon-192.png" alt="" width="40" height="40" />
      <p><strong>${escapeHtml(t("install.banner.title"))}</strong> ${escapeHtml(t(ios ? "install.banner.ios" : "install.banner.message"))}${ios ? ` ${escapeHtml(t("install.banner.iosCarryOver"))}` : ""}</p>
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
    // One attempt at a time: the held event is single-use, so a second tap
    // mid-dialog would find nothing to prompt with.
    if (this._busy) return;
    this._busy = true;
    const button = this.querySelector(".install-banner__install");
    if (button instanceof HTMLButtonElement) button.disabled = true;
    let outcome = null;
    try {
      outcome = await promptInstall();
    } finally {
      this._busy = false;
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
    void trackEvent("install_prompt_answered", {
      method: this._method,
      outcome: outcome ?? "unavailable",
    });
    if (outcome === "dismissed") {
      // Declined in the browser's dialog: that is a "not now".
      this._dismiss(false);
      return;
    }
    // Accepted, or nothing left to prompt with (installed meanwhile, event
    // spent): either way the offer is over, and neither is a dismissal.
    this.remove();
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
