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
import {
  hasAdminAccess,
  getSite,
  resetLocalAppState,
  saveSiteSettings,
} from "../db.js";
import { getSiteSettings } from "../services/api.js";
import {
  startHealthMonitoring,
  stopHealthMonitoring,
  clearAuthState,
} from "../services/backend-health.js";
import {
  currentRoute,
  onRouteChange,
  navigate,
  replaceRoute,
} from "../router.js";
import { hasDraft } from "../state/check-session.js";
import {
  captureRouteToRestore,
  captureResumeProperties,
} from "../state/capture-resume.js";
import { trackEvent } from "../services/analytics.js";
import { setupView, appShell } from "./app-root.templates.js";
import "./connection-status.js";
import { isInAppBrowser } from "../services/browser-context.js";
import {
  deepActiveElement,
  isEditable,
  keyboardViewport,
} from "../services/keyboard-viewport.js";
import {
  showQueuedSiteSwitchSuccessToast,
  showSiteSwitchSuccessToast,
} from "../state/toasts.js";
import { ready as i18nReady } from "../i18n/i18n.js";

const ROUTE_VIEW = [
  ["/site-admin/edit", "site-admin-edit"],
  ["/site-admin", "site-admin-view"],
  ["/problem/describe", "describe-instead"],
  ["/problem", "problem-report"],
  ["/check/describe", "describe-instead"],
  ["/check", "perimeter-check"],
  ["/today", "today-view"],
];

class AppRoot extends HTMLElement {
  async connectedCallback() {
    if (!this._onPhotoLightbox) {
      this._onPhotoLightbox = (event) => {
        const trigger = event.target?.closest?.("[data-photo-lightbox]");
        if (!trigger) return;
        event.preventDefault();
        // Polling may replace the thumbnail while the lazy module loads.
        // Keep the originating screen as the navigation guard instead.
        const screen = trigger.closest(".app__main > *");
        void import("./photo-lightbox.js").then(({ openPhotoLightbox }) =>
          openPhotoLightbox(this, trigger, screen),
        );
      };
      this.addEventListener("click", this._onPhotoLightbox);
    }
    this._startKeyboardViewportSync();
    if (this._isDevResetRoute()) {
      await this._resetFirstLaunch();
      return;
    }
    // The stored language's catalog must be in place before any template
    // runs; English resolves immediately, other locales await their chunk.
    await i18nReady;
    if (!this._onLocaleChange) {
      // Every screen renders from state, so a language switch is a full
      // re-render of the shell and the current view (or the setup screen).
      this._onLocaleChange = () => {
        if (!this.isConnected) return;
        if (!this._site) {
          this._renderSetup();
          return;
        }
        // Only the view: the shell chrome is hidden, and re-creating it would
        // re-show a dismissed in-app-browser banner and replay queued toasts.
        this._renderView();
      };
      window.addEventListener("localechange", this._onLocaleChange);
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
    this._onSiteRequested = (event) => {
      const { siteId = "", siteName = "", mode = "code" } = event.detail || {};
      this._renderSetup({
        targetSiteId: siteId,
        targetSiteName: siteName,
        mode,
        canCancel: Boolean(this._site),
      });
    };
    this.addEventListener("siterequested", this._onSiteRequested);
    // Health monitoring starts regardless of binding state: /health is
    // authorizer-free, and the AUTH dialog is meaningful before setup too.
    startHealthMonitoring();
    if (!this._site) {
      this._renderSetup();
      return;
    }
    await this._refreshSiteSettings();
    await this._restoreInterruptedCapture();
    this._renderApp();
    this._unsub = onRouteChange(() => this._renderView());
    this._renderView();
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
    stopHealthMonitoring();
    window.removeEventListener("authsignout", this._onAuthSignout);
    window.removeEventListener("localechange", this._onLocaleChange);
    this._onLocaleChange = null;
    this.removeEventListener("siterequested", this._onSiteRequested);
    this._stopKeyboardViewportSync();
    this.removeEventListener("click", this._onPhotoLightbox);
    this._onPhotoLightbox = null;
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
    // Pans (Safari revealing a newly focused field, or the user dragging)
    // change offsetTop without a resize; only "scroll" reports them.
    viewport.addEventListener("scroll", this._onKeyboardViewport);
    document.addEventListener("focusin", this._onKeyboardViewport);
    document.addEventListener("focusout", this._onKeyboardViewport);
  }

  _stopKeyboardViewportSync() {
    if (!this._onKeyboardViewport) return;
    window.visualViewport?.removeEventListener(
      "resize",
      this._onKeyboardViewport,
    );
    window.visualViewport?.removeEventListener(
      "scroll",
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

  _renderSetup(options = {}) {
    const switchingSite = Boolean(this._site);
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this.innerHTML = setupView(options);
    this.append(document.createElement("app-toasts"));
    this.append(document.createElement("connection-status"));
    this._maybeWarnInAppBrowser();
    this.querySelector("site-setup").addEventListener("sitecancel", () => {
      if (!this._site) return;
      this._renderApp();
      this._unsub = onRouteChange(() => this._renderView());
      this._renderView();
    });
    this.querySelector("site-setup").addEventListener("sitebound", async () => {
      this._site = await getSite();
      clearAuthState(); // re-bind heals an AUTH state
      void trackEvent("site_setup_completed", {
        switching_site: switchingSite,
      });
      await this._refreshSiteSettings();
      this._renderApp();
      if (switchingSite) showSiteSwitchSuccessToast();
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
    showQueuedSiteSwitchSuccessToast();
  }

  /**
   * In-app-webview heads-up: known webviews silently break the camera intent,
   * so warn once per load and offer the escape hatch (Safari / default
   * browser). Dismissible; nothing about the app is blocked.
   */
  _maybeWarnInAppBrowser() {
    if (!isInAppBrowser()) return;
    void import("./webview-warning.js").then(({ showWebviewWarning }) =>
      showWebviewWarning(this),
    );
  }

  /**
   * Field fix (2026-10): on older Android devices the browser is killed while
   * the camera is open and relaunches at the entry URL, so the user lands on
   * home mid-check. The capture screen left a marker when it opened the
   * camera; if it is fresh and the draft is still there, replace home with
   * the capture route before the first render. The analytics event records
   * how the relaunch looked so the field pattern can be confirmed in PostHog.
   */
  async _restoreInterruptedCapture() {
    let restore = null;
    try {
      restore = await captureRouteToRestore({
        route: currentRoute(),
        hasDraft,
      });
    } catch (err) {
      console.error("capture resume check failed", err);
    }
    if (!restore) return;
    void trackEvent("capture_resumed", captureResumeProperties(restore));
    replaceRoute(restore.route);
  }

  _renderView() {
    const route = currentRoute();
    if (this._isDevResetRoute(route)) {
      void this._resetFirstLaunch();
      return;
    }
    if (route.startsWith("/site-admin") && !hasAdminAccess(this._site)) {
      navigate("/today");
      return;
    }
    if (
      route.startsWith("/site-admin") &&
      !customElements.get("site-admin-view")
    ) {
      this._view.replaceChildren();
      void import("./site-admin.js").then(() => {
        if (currentRoute().startsWith("/site-admin")) this._renderView();
      });
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
    const swap = () => {
      // Always mount a fresh element (each screen reads current state on
      // connect).
      this._view.replaceChildren(document.createElement(tag));
      this._restateScreenFocus();
    };
    // Same-document View Transition: cross-fades the route swap (full-blown
    // zoom animations could re-use this hook later). No-op where unsupported.
    // The API does NOT honor prefers-reduced-motion on its own: base.css
    // zeroes the ::view-transition-* animations as the safety net, and we skip
    // the call entirely here so those users also avoid the snapshot pause.
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion && typeof document.startViewTransition === "function") {
      document.startViewTransition(swap);
    } else {
      swap();
    }
  }

  /**
   * Hand focus to the new screen's programmatic focus point (title or a
   * screen-declared target): routing is a page-level event, so the screen's
   * own heading should receive focus — not <main>. <main> (tabindex="-1")
   * remains the silent fallback target and never draws a ring (outline:
   * none). Screens may still move focus onward to a meaningful control
   * after async setup (e.g. describe-instead focuses its text field).
   */
  _restateScreenFocus() {
    const view = this._view;
    if (!view) return;
    this._afterMount(() => {
      const viewFocusPoint =
        view.querySelector("[data-screen-focus]") ||
        view.querySelector("h1[tabindex='-1']");
      if (viewFocusPoint instanceof HTMLElement) {
        viewFocusPoint.focus();
      } else {
        view.focus();
      }
    });
  }

  /** @param {() => void} fn */
  _afterMount(fn) {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(fn);
    } else {
      fn();
    }
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
