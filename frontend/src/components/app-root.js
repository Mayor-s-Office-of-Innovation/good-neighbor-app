// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  app-root — the shell. Enforces first-run site setup, renders the header, and swaps
  the main view based on the route. Everything is scoped to the bound site.

  Routes → views: /today → today-view, /check → perimeter-check, /problem →
  problem-report, /check/describe + /problem/describe → describe-instead.
  Setup (device→site binding) is retained and gates everything. There is no
  per-site places setup any more (docs/plan-remove-places.md): a bound device
  lands straight on home.
*/
import { requestLocationPermissionEarly } from "../services/device-location.js";
import { getSite, resetLocalAppState, saveSiteSettings } from "../db.js";
import { getSiteSettings } from "../services/api.js";
import {
  startHealthMonitoring,
  stopHealthMonitoring,
  clearAuthState,
} from "../services/backend-health.js";
import { currentRoute, onRouteChange, navigate } from "../router.js";
import { setupView, appShell } from "./app-root.templates.js";
import "./connection-status.js";
import {
  isInAppBrowser,
  escapeUrlForPlatform,
} from "../services/browser-context.js";
import { reportClientEvent } from "../services/error-report.js";
import {
  deepActiveElement,
  isEditable,
  keyboardViewport,
} from "../services/keyboard-viewport.js";

const ROUTE_VIEW = [
  ["/problem/describe", "describe-instead"],
  ["/problem", "problem-report"],
  ["/check/describe", "describe-instead"],
  ["/check", "perimeter-check"],
  ["/today", "today-view"],
];

if (import.meta.env.DEV) {
  ROUTE_VIEW.unshift(["/dev/guidance-harness", "guidance-harness"]);
}

class AppRoot extends HTMLElement {
  async connectedCallback() {
    this._startKeyboardViewportSync();
    if (this._isDevResetRoute()) {
      await this._resetFirstLaunch();
      return;
    }
    requestLocationPermissionEarly();
    this._site = await getSite();
    this._onAuthSignout = () => {
      // Recovery is IN PROGRESS: the user chose sign-out, so the health
      // state must leave `auth` now — a freshly mounted connection-status on
      // the setup screen would otherwise re-open its modal over the site
      // form and make recovery unreachable. (sitebound's clearAuthState
      // below stays as belt-and-braces for AUTH states detected later.)
      clearAuthState();
      // The site binding is gone; re-render the first-run setup screen.
      this._site = null;
      if (this._unsub) this._unsub();
      this._renderSetup();
    };
    window.addEventListener("authsignout", this._onAuthSignout);
    // Health monitoring starts regardless of binding state: /health is
    // authorizer-free, and the AUTH dialog is meaningful before setup too.
    startHealthMonitoring();
    if (!this._site) {
      this._renderSetup();
      return;
    }
    await this._refreshSiteSettings();
    this._renderApp();
    this._unsub = onRouteChange(() => this._renderView());
    this._renderView();
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
    stopHealthMonitoring();
    window.removeEventListener("authsignout", this._onAuthSignout);
    this._stopKeyboardViewportSync();
  }

  /**
   * iOS keyboard fallback (see services/keyboard-viewport.js). While an
   * editable control has focus and the keyboard has shrunk only the visual
   * viewport, expose its height and pan offset to the shell's CSS.
   */
  _startKeyboardViewportSync() {
    const viewport = window.visualViewport;
    if (!viewport || this._onKeyboardViewport) return;
    this._onKeyboardViewport = () => this._syncKeyboardViewport();
    viewport.addEventListener("resize", this._onKeyboardViewport);
    document.addEventListener("focusin", this._onKeyboardViewport);
    document.addEventListener("focusout", this._onKeyboardViewport);
  }

  _stopKeyboardViewportSync() {
    if (!this._onKeyboardViewport) return;
    window.visualViewport?.removeEventListener(
      "resize",
      this._onKeyboardViewport,
    );
    document.removeEventListener("focusin", this._onKeyboardViewport);
    document.removeEventListener("focusout", this._onKeyboardViewport);
    this._onKeyboardViewport = null;
    this._applyKeyboardViewport(null);
  }

  _syncKeyboardViewport() {
    const editing = isEditable(deepActiveElement(document));
    this._applyKeyboardViewport(
      keyboardViewport(window.visualViewport, window.innerHeight, editing),
    );
  }

  /** @param {{ height: number, top: number } | null} box */
  _applyKeyboardViewport(box) {
    if (!box) {
      this.style.removeProperty("--app-viewport-height");
      this.style.removeProperty("--app-viewport-top");
      return;
    }
    this.style.setProperty("--app-viewport-height", `${box.height}px`);
    this.style.setProperty("--app-viewport-top", `${box.top}px`);
  }

  _renderSetup() {
    this.innerHTML = setupView();
    this.append(document.createElement("connection-status"));
    this._maybeWarnInAppBrowser();
    this.querySelector("site-setup").addEventListener("sitebound", async () => {
      this._site = await getSite();
      clearAuthState(); // re-bind heals an AUTH state
      await this._refreshSiteSettings();
      this._renderApp();
      this._unsub = onRouteChange(() => this._renderView());
      navigate("/today");
      this._renderView();
    });
  }

  _renderApp() {
    this.innerHTML = appShell({ siteName: this._site.name });
    this.append(document.createElement("app-toasts"));
    this.append(document.createElement("connection-status"));
    this._maybeWarnInAppBrowser();
    this._view = this.querySelector("#view");
    this._shell = this.querySelector(".app");
  }

  /**
   * In-app-webview heads-up: known webviews silently break the camera intent,
   * so warn once per load and offer the escape hatch (Safari / default
   * browser). Dismissible; nothing about the app is blocked.
   */
  _maybeWarnInAppBrowser() {
    if (!isInAppBrowser()) return;
    reportClientEvent("in_app_browser", "in-app webview detected at boot", {});
    const host = this.querySelector(".app__main") || this;
    host.insertAdjacentHTML(
      "afterbegin",
      `<div class="webview-banner" role="status">
        <p>
          <strong>Camera may not open here.</strong> You're inside another app's
          browser. Open in your browser instead for the camera to work.
        </p>
        <button class="webview-banner__open" type="button">Open in browser</button>
        <button class="webview-banner__close" type="button" aria-label="Dismiss">
          ✕
        </button>
      </div>`,
    );
    this.querySelector(".webview-banner__open")?.addEventListener(
      "click",
      () => {
        const url = escapeUrlForPlatform();
        if (!url) return;
        // Both the iOS handoff (target=_blank → Safari) and the Android
        // intent URL must be triggered from a user gesture.
        window.open(url, "_blank", "noopener");
      },
    );
    this.querySelector(".webview-banner__close")?.addEventListener(
      "click",
      () => this.querySelector(".webview-banner")?.remove(),
    );
  }

  _renderView() {
    const route = currentRoute();
    if (this._isDevResetRoute(route)) {
      void this._resetFirstLaunch();
      return;
    }
    const match = ROUTE_VIEW.find(([prefix]) => route.startsWith(prefix));
    const tag = match ? match[1] : "today-view";
    // Every screen owns its own header now (design port): the home hub has its
    // site header, and each flow screen has a .topbar. So the shell chrome stays
    // hidden throughout — the shell is just the routing container.
    if (this._shell) {
      this._shell.classList.add("app--chromeless");
    }
    // Always mount a fresh element (each screen reads current state on connect).
    this._view.replaceChildren(document.createElement(tag));
    this._view.focus();
  }

  /**
   * Pull the site's settings (name etc.) from the backend and merge them onto
   * the local binding record. Best-effort: the app runs on the stored record
   * when the request fails.
   */
  async _refreshSiteSettings() {
    try {
      const { site } = await getSiteSettings();
      if (site) {
        this._site = await saveSiteSettings({
          ...site,
          providerSiteId: this._site.providerSiteId || site.providerSiteId,
        });
      }
    } catch (err) {
      console.error("getSiteSettings failed", err);
    }
  }

  _isDevResetRoute(route = currentRoute()) {
    return (
      Boolean(/** @type {any} */ (import.meta).env?.DEV) &&
      route.startsWith("/dev/reset-first-launch")
    );
  }

  async _resetFirstLaunch() {
    await resetLocalAppState();
    this._site = null;
    history.replaceState({}, "", "/today");
    this._renderSetup();
  }
}
customElements.define("app-root", AppRoot);
