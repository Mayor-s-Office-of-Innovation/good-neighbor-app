// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
import { loadError } from "./load-error.js";
import { startPhoneCompletionRecovery } from "../services/phone-completion.js";
/*
  app-root — the shell. Enforces first-run site setup, renders the header, and swaps
  the main view based on the route. Everything is scoped to the bound site.

  Routes → views: /today → today-view, /check → perimeter-check, /problem →
  problem-report, /check/describe + /problem/describe → describe-instead,
  Capture flows and manager-only screens load their modules on navigation.
  Setup (device→site binding) is retained and gates everything. There is no
  per-site places setup any more (docs/plan-remove-places.md): a bound device
  lands straight on home.
*/
import { setDuplicateUiSite } from "../services/feature-flags.js";
import { requestLocationPermissionEarly } from "../services/device-location.js";
import { refreshSessionTranslationsOnLocaleChange } from "../services/session-translations.js";
import {
  bindingFromSession,
  hasAdminAccess,
  clearSite,
  getSite,
  resetLocalAppState,
  saveDiscoveredBindings,
  saveSiteSettings,
  setSite,
} from "../db.js";
import { getSiteSettings, listDeviceBindings } from "../services/api.js";
import { ApiError, InvalidHandoffGrantError } from "../services/api-error.js";
import { redeemHandoffGrant } from "../services/devices.js";
import {
  ensureHandoffManifest,
  readHandoffCredentials,
  rememberConsumedGrant,
  stripHandoffCredentials,
  uninstallHandoffManifest,
} from "../services/session-handoff.js";
import {
  startHealthMonitoring,
  stopHealthMonitoring,
  clearAuthState,
} from "../services/backend-health.js";
import {
  currentRoute,
  backOrNavigate,
  navigate,
  onRouteChange,
  replaceRoute,
  routeTransitionDirection,
} from "../router.js";
import { hasDraft } from "../state/check-session.js";
import {
  captureRouteToRestore,
  captureResumeProperties,
} from "../state/capture-resume.js";
import { trackEvent } from "../services/analytics.js";
import { setupView, appShell, handoffView } from "./app-root.templates.js";
import "./connection-status.js";
import { isInAppBrowser } from "../services/browser-context.js";
import {
  isStandalone,
  shouldOfferInstall,
} from "../services/install-prompt.js";
import {
  deepActiveElement,
  isEditable,
  keyboardViewport,
  revealEditable,
} from "../services/keyboard-viewport.js";
import {
  hasEnrollmentCredentials,
  isFatalSessionError,
} from "../services/startup-auth.js";
import { escapeHtml } from "../lib/html.js";
import { ready as i18nReady, t } from "../i18n/i18n.js";

const ROUTE_VIEW = [
  ["/help", "support-view"],
  ["/care-work", "care-work-view"],
  ["/complaints", "complaint-view"],
  ["/reports/checks/", "reports-day-view"],
  ["/reports/issues/", "reports-type-view"],
  ["/reports", "reports-view"],
  ["/site-admin/edit", "site-admin-edit"],
  ["/manage-access", "site-access-view"],
  ["/site-admin/access", "site-access-view"],
  ["/site-admin", "site-admin-view"],
  ["/problem/describe", "describe-instead"],
  ["/problem", "problem-report"],
  ["/check/describe", "describe-instead"],
  ["/check", "perimeter-check"],
  ["/today", "today-view"],
];

/**
 * Analytics bucket for a failed Home Screen handoff. Never the grant itself.
 * `rejected` is final (the grant is consumed, expired, or superseded);
 * everything else may succeed on the next launch.
 * @param {unknown} err
 * @returns {"rejected" | "network" | "error" | "storage"}
 */
function handoffFailureReason(err) {
  if (err instanceof InvalidHandoffGrantError) return "rejected";
  if (err instanceof ApiError) return err.status === 0 ? "network" : "error";
  return "storage";
}

/** Avoid invalidating styles when viewport values have not changed.
 * @param {CSSStyleDeclaration} style @param {string} name @param {string} value
 */
function syncViewportProperty(style, name, value) {
  if (style.getPropertyValue(name) === value) return;
  if (value) style.setProperty(name, value);
  else style.removeProperty(name);
}

export class AppRoot extends HTMLElement {
  /** @type {string | null} the route the view last swapped to */
  _swappedRoute = null;
  _routeTransitionId = 0;

  async connectedCallback() {
    // Home Screen handoff credentials ride the launch URL's fragment
    // (services/session-handoff.js). Read and strip them synchronously, before
    // anything awaits or reads the location; they are acted on below once the
    // stored binding is known.
    // Stripped whenever present — including a grant this install already
    // consumed, which the reader hides — so the address bar and history
    // entry never keep the secret.
    const handoff = readHandoffCredentials();
    stripHandoffCredentials();
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
        if (!this._site || this.querySelector("site-setup")) {
          // Keep pending enrollment credentials in the existing component:
          // their fragment was stripped before the confirmation step.
          const setup = this.querySelector("site-setup");
          if (setup) setup._render();
          else this._renderSetup();
          return;
        }
        // Only the view: the shell chrome is hidden, and re-creating it would
        // re-show a dismissed in-app-browser banner and replay queued toasts.
        this._renderView();
        // Cards in an active capture render from session state captured when
        // the analysis landed; pull in the locales the backend filled since.
        void refreshSessionTranslationsOnLocaleChange();
      };
      window.addEventListener("localechange", this._onLocaleChange);
    }
    requestLocationPermissionEarly();
    this._site = await getSite();
    this._stopPhoneRecovery?.();
    this._stopPhoneRecovery = startPhoneCompletionRecovery();
    this._onAuthSignout = () => {
      setDuplicateUiSite(null);
      // Recovery is IN PROGRESS: the user chose sign-out, so the health
      // state must leave `auth` now — a freshly mounted connection-status on
      // the setup screen would otherwise re-open its modal over the site
      // form and make recovery unreachable. (sitebound's clearAuthState
      // below stays as belt-and-braces for AUTH states detected later.)
      clearAuthState();
      // Backstop for the sign-out paths: the page must not keep offering a
      // handoff grant for a session that no longer exists.
      uninstallHandoffManifest();
      // The site binding is gone; re-render the first-run setup screen.
      this._site = null;
      if (this._unsub) this._unsub();
      this._renderSetup();
    };
    window.addEventListener("authsignout", this._onAuthSignout);
    this._onEnrollmentUrlChange = () => {
      if (hasEnrollmentCredentials(location.href, Boolean(this._site)))
        this._beginEnrollmentFromUrl();
    };
    window.addEventListener("hashchange", this._onEnrollmentUrlChange);
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
    if (hasEnrollmentCredentials(location.href, Boolean(this._site))) {
      this._beginEnrollmentFromUrl();
      return;
    }
    if (!this._site) {
      if (handoff || isStandalone())
        await this._beginHandoffFromUrl(handoff ?? {});
      else this._renderSetup();
      return;
    }
    // A later launch of the installed app whose start URL still carries a
    // grant this install has not recorded as consumed (storage was cleared):
    // a stale grant never replaces a live session.
    if (handoff) void trackEvent("handoff_stale_ignored", {});
    await this._restoreInterruptedCapture();
    this._renderApp();
    this._unsub = onRouteChange(() => this._renderView());
    this._renderView();
    // Off the critical path: the shell and the first screen render from the
    // stored binding, and the settings refresh (site name, flags, and the
    // revocation check) lands behind them instead of costing a serial round
    // trip before anything paints. A revoked session still ends on the setup
    // screen (see _refreshSiteSettings), and every request the first screen
    // makes is re-authorized by the backend anyway.
    void this._refreshSiteSettings().catch((err) =>
      console.error("site settings refresh failed", err),
    );
  }

  disconnectedCallback() {
    this._stopPhoneRecovery?.();
    if (this._unsub) this._unsub();
    stopHealthMonitoring();
    window.removeEventListener("authsignout", this._onAuthSignout);
    window.removeEventListener("hashchange", this._onEnrollmentUrlChange);
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
    document.addEventListener("input", this._onKeyboardViewport);
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
    document.removeEventListener("input", this._onKeyboardViewport);
    this._onKeyboardViewport = null;
    document.documentElement.removeAttribute("data-keyboard-open");
    document.documentElement.style.removeProperty("--editable-viewport-height");
    document.documentElement.style.removeProperty("--editable-viewport-top");
    this._applyKeyboardViewport(null);
  }

  _syncKeyboardViewport() {
    const active = deepActiveElement(document);
    const editing = isEditable(active);
    const root = document.documentElement;
    const wasOpen = root.hasAttribute("data-keyboard-open");
    const box = keyboardViewport(
      window.visualViewport,
      window.innerHeight,
      editing || wasOpen,
    );
    if (wasOpen !== Boolean(box))
      root.toggleAttribute("data-keyboard-open", Boolean(box));
    const syncing = editing || Boolean(box);
    syncViewportProperty(
      root.style,
      "--editable-viewport-height",
      syncing ? `${window.visualViewport?.height || window.innerHeight}px` : "",
    );
    syncViewportProperty(
      root.style,
      "--editable-viewport-top",
      syncing ? `${box?.top || 0}px` : "",
    );
    this._applyKeyboardViewport(box);
    if (editing && window.visualViewport?.scale === 1) {
      requestAnimationFrame(() => {
        if (deepActiveElement(document) !== active) return;
        revealEditable(active, window.visualViewport);
      });
    }
  }

  /** @param {{ height: number, top: number } | null} box */
  _applyKeyboardViewport(box) {
    syncViewportProperty(
      this.style,
      "--app-viewport-height",
      box ? `${box.height}px` : "",
    );
    syncViewportProperty(
      this.style,
      "--app-viewport-top",
      box ? `${box.top}px` : "",
    );
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
      void trackEvent("site_setup_completed", {
        switching_site: switchingSite,
      });
      if (!(await this._enterAppAfterBind())) return;
    });
  }

  _beginEnrollmentFromUrl() {
    // A one-time enrollment link is an explicit request to replace the cached
    // binding. Mount setup even when IndexedDB still holds an older (possibly
    // revoked) session. Clearing an earlier AUTH presentation keeps its modal
    // from covering the automatic redemption state.
    clearAuthState();
    this._renderSetup();
  }

  /**
   * First launch of the Home Screen app (services/session-handoff.js): the
   * launch URL carried a handoff grant and IndexedDB holds no session. Redeem
   * it for a session on the same device record, then render the hub as a
   * fresh bind would. Any failure lands on the setup screen with a notice
   * saying why the code is being asked for.
   * @param {{ grantId: string, token: string }} credentials
   */
  async _beginHandoffFromUrl({ grantId, token }) {
    clearAuthState();
    this._renderHandoff();
    let session;
    try {
      session = await redeemHandoffGrant(grantId, token);
    } catch (err) {
      const reason = handoffFailureReason(err);
      // The start URL carries this grant for the life of the install: once
      // the server has said no for good, never present it again. A network
      // blip may succeed on the next launch, so that one is not remembered.
      if (reason === "rejected" && grantId) rememberConsumedGrant(grantId);
      if (grantId || reason !== "rejected")
        void trackEvent("handoff_failed", { reason });
      this._renderSetup(
        grantId || reason !== "rejected" ? { notice: "handoffFailed" } : {},
      );
      return;
    }
    if (grantId) rememberConsumedGrant(grantId);
    try {
      await setSite(session.site.name, bindingFromSession(session));
    } catch (err) {
      console.error("handoff session could not be stored", err);
      void trackEvent("handoff_failed", { reason: "storage" });
      this._renderSetup({ notice: "handoffFailed" });
      return;
    }
    // Binding-backed devices keep their site switcher: the handed-off session
    // is for one binding, the others are re-discovered through the API.
    if (session.physicalDeviceId) {
      try {
        const { bindings } = await listDeviceBindings();
        await saveDiscoveredBindings(bindings || [], session.physicalDeviceId);
      } catch (err) {
        console.error("device bindings refresh failed after handoff", err);
      }
    }
    void trackEvent("handoff_redeemed", {});
    await this._enterAppAfterBind();
  }

  /** The handoff-in-progress screen: setup chrome, spinner, no code form. */
  _renderHandoff() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this.innerHTML = handoffView();
    this.append(document.createElement("app-toasts"));
    this.append(document.createElement("connection-status"));
  }

  /**
   * A session was just stored (site code, enrollment link, or Home Screen
   * handoff): read it back, refresh settings (a revoked session ends on the
   * setup screen here), and render the hub.
   * @returns {Promise<boolean>} false when the session was rejected
   */
  async _enterAppAfterBind() {
    this._site = await getSite();
    clearAuthState(); // re-bind heals an AUTH state
    if (!(await this._refreshSiteSettings())) return false;
    // Complete the installation cookie before the enrolled app is shown: the
    // person may immediately use Safari's own Add to Home Screen menu.
    await ensureHandoffManifest({ site: this._site }).catch((err) =>
      console.error("handoff preparation failed", err),
    );
    this._renderApp();
    this._unsub = onRouteChange(() => this._renderView());
    navigate("/today");
    this._renderView();
    return true;
  }

  _renderApp() {
    this.innerHTML = appShell({ siteName: this._site.name });
    this.append(document.createElement("app-toasts"));
    this.append(document.createElement("connection-status"));
    this._maybeWarnInAppBrowser();
    this._view = this.querySelector("#view");
    this._shell = this.querySelector(".app");
    this._maybeOfferInstall();
    // iOS Safari only, and only while not yet standalone: keep a handoff grant
    // in the manifest so an Add to Home Screen from any route carries the
    // session over. Off the critical path; the iOS install offer waits for it.
    void ensureHandoffManifest({ site: this._site }).catch((err) =>
      console.error("handoff manifest failed", err),
    );
  }

  /**
   * Add-to-Home-Screen offer: a bound device on the home hub gets one card
   * (Install on Chromium, Share-sheet steps on iOS Safari). The service
   * decides eligibility (standalone already, webview, snoozed); the element
   * sits above <main> so route swaps leave it alone and hides itself off
   * /today. Lazy like the webview banner to keep it out of the main bundle.
   */
  _maybeOfferInstall() {
    if (!this._shell || !shouldOfferInstall()) return;
    void import("./install-prompt.js").then(() => {
      if (
        !this._shell?.isConnected ||
        !shouldOfferInstall() ||
        this.querySelector("install-prompt")
      )
        return;
      this._shell.insertBefore(
        document.createElement("install-prompt"),
        this._view,
      );
    });
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

  _loadRoute(route, load) {
    const request = (this._routeLoad = {});
    if (!this._view.firstElementChild)
      this._view.innerHTML = `<p role="status">${escapeHtml(t("care.loading"))}</p>`;
    this._view.inert = true;
    Promise.resolve()
      .then(load)
      .then(() => {
        if (this._routeLoad === request && currentRoute() === route)
          this._renderView();
      })
      .catch((error) => {
        if (this._routeLoad !== request || currentRoute() !== route) return;
        this._view.inert = false;
        console.error("Route module failed to load", error);
        this._view.innerHTML = `${loadError(t("route.loadError"), { retryAttribute: "data-route-reload" })}<button type="button" class="btn-outline" data-route-back>${escapeHtml(t("common.back"))}</button>`;
        // Reload obtains the current asset manifest and clears cached import failures.
        this._view
          .querySelector("[data-route-reload]")
          .addEventListener("click", () => location.reload());
        this._view
          .querySelector("[data-route-back]")
          .addEventListener("click", () => backOrNavigate("/today"));
      });
  }

  _renderView() {
    this._routeLoad = null;
    const route = currentRoute();
    if (this._isDevResetRoute(route)) {
      void this._resetFirstLaunch();
      return;
    }
    // Manager-only screens: site admin and the reports. The access level is
    // a navigation hint from the stored token; the backend enforces it.
    const managerOnly =
      route.startsWith("/site-admin") ||
      route.startsWith("/manage-access") ||
      route.startsWith("/reports");
    if (managerOnly && !hasAdminAccess(this._site)) {
      navigate("/today");
      return;
    }
    const match = ROUTE_VIEW.find(([prefix]) => route.startsWith(prefix));
    const tag = match ? match[1] : "today-view";
    const lazy = [
      [route === "/help", "support-view", () => import("./support-view.js")],
      [
        tag === "describe-instead",
        "describe-instead",
        () => import("./describe-instead.js"),
      ],
      [
        tag === "perimeter-check",
        "perimeter-check",
        () => import("./perimeter-check.js"),
      ],
      [
        tag === "problem-report",
        "problem-report",
        () => import("./problem-report.js"),
      ],
      [
        route.startsWith("/site-admin") || route.startsWith("/manage-access"),
        "site-admin-view",
        () => import("./site-admin.js"),
      ],
      [
        route.startsWith("/care-work"),
        "care-work-view",
        () => import("./care-work-view.js"),
      ],
      [
        route.startsWith("/complaints"),
        "complaint-view",
        () => import("./complaint-view.js"),
      ],
      [
        route.startsWith("/reports"),
        "reports-view",
        () => import("./reports-view.js"),
      ],
    ].find(([matches, tag]) => matches && !customElements.get(tag));
    if (lazy) {
      this._loadRoute(route, lazy[2]);
      return;
    }
    // Every screen owns its own header now (design port): the home hub has its
    // site header, and each flow screen has a .topbar. So the shell chrome stays
    // hidden throughout — the shell is just the routing container.
    if (this._shell) {
      this._shell.classList.add("app--chromeless");
    }
    const direction = routeTransitionDirection(this._swappedRoute, route);
    const swap = () => {
      // Always mount a fresh element (each screen reads current state on
      // connect).
      if (currentRoute() !== route) return;
      this._swappedRoute = route;
      this._view.replaceChildren(document.createElement(tag));
      this._view.inert = false;
      this._restateScreenFocus();
    };
    // Same-document View Transition: a cross-fade between sibling screens,
    // a slide from the right when the new screen is a level deeper (its
    // back arrow returns here) and back out when it is a level shallower;
    // base.css keys the animations off <html data-route-transition>. No-op
    // where unsupported. The API does NOT honor prefers-reduced-motion on
    // its own: base.css zeroes the ::view-transition-* animations as the
    // safety net, and we skip the call entirely here so those users also
    // avoid the snapshot pause.
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion && typeof document.startViewTransition === "function") {
      const id = ++this._routeTransitionId;
      document.documentElement.dataset.routeTransition = direction;
      const transition = document.startViewTransition(swap);
      // A navigation that lands mid-swap skips this transition; those
      // rejections are expected, not errors.
      transition.ready.catch(() => {});
      transition.updateCallbackDone.catch(() => {});
      transition.finished
        .catch(() => {})
        .then(() => {
          if (id === this._routeTransitionId)
            delete document.documentElement.dataset.routeTransition;
        });
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
      // A toast may have focused Undo since this route announcement was queued.
      if (document.activeElement?.closest?.("app-toasts")) return;
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
   * when a transient request fails. A rejected or revoked session is fatal:
   * clear the current binding and return to setup. On first launch this runs
   * behind the already-rendered shell, so a changed site name is written into
   * the header here and a dead session tears the shell down.
   *
   * Because it no longer blocks the app, the user can act while it is in
   * flight: both outcomes are dropped when the answer belongs to a binding
   * that is no longer the current one, and a rejection only clears a session
   * that is still the one this request rode (a plain 401 can also mean a
   * retry superseded by a newer rotation — see services/api.js).
   * @returns {Promise<boolean>} whether the app shell may stay rendered
   */
  async _refreshSiteSettings() {
    setDuplicateUiSite(null);
    const bound = this._site;
    try {
      const { site } = await getSiteSettings();
      if (this._site !== bound) return true;
      if (site) {
        const saved = await saveSiteSettings(
          {
            ...site,
            providerSiteId: bound.providerSiteId || site.providerSiteId,
          },
          bound.siteId,
        );
        if (!saved) return true;
        this._site = saved;
        setDuplicateUiSite(
          site.siteId && site.siteId !== saved.siteId ? null : site,
        );
        const title = this.querySelector(".app__title");
        if (title && title.textContent !== saved.name) {
          title.textContent = saved.name;
        }
      }
      return true;
    } catch (err) {
      if (isFatalSessionError(err)) {
        // Stale verdicts are not ours to act on: the binding was replaced or
        // cleared meanwhile, the user is already on the setup screen binding
        // another site (tearing that down would orphan its `sitebound`), or a
        // newer session was stored since this request started.
        if (this._site !== bound || this.querySelector("site-setup")) {
          return true;
        }
        const stored = await getSite().catch(() => null);
        if (!stored || stored.token !== bound?.token) return true;
        await clearSite();
        this._site = null;
        clearAuthState();
        uninstallHandoffManifest();
        this._renderSetup();
        return false;
      }
      console.error("getSiteSettings failed", err);
      return true;
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
    uninstallHandoffManifest();
    this._site = null;
    history.replaceState({}, "", "/today");
    this._renderSetup();
  }
}
customElements.define("app-root", AppRoot);
