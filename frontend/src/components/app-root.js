// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  app-root — the shell. Enforces first-run site setup, renders the header, and swaps
  the main view based on the hash route. Everything is scoped to the bound site.

  Routes → views: /today → today-view, /check → perimeter-check, /review →
  check-review, /results → check-results. Setup (device→site binding) is retained and
  gates everything (see docs/take5-plan.md).
*/
import { getSite, resetLocalAppState, saveSiteSettings } from "../db.js";
import { getSiteSettings } from "../services/api.js";
import { currentRoute, onRouteChange, navigate } from "../router.js";
import { setupView, appShell } from "./app-root.templates.js";

const ROUTE_VIEW = [
  ["/problem/describe", "describe-instead"],
  ["/problem", "problem-report"],
  ["/check/describe", "describe-instead"],
  ["/places/setup", "places-setup"],
  ["/places/edit", "places-setup"],
  ["/check", "perimeter-check"],
  ["/review", "check-review"],
  ["/results", "check-results"],
  ["/today", "today-view"],
];

if (import.meta.env.DEV) {
  ROUTE_VIEW.unshift(["/dev/guidance-harness", "guidance-harness"]);
}

export function hasConfirmedPlaces(site) {
  return (
    Array.isArray(site?.places) &&
    site.places.some((place) => String(place?.name || "").trim()) &&
    Boolean(site.placesConfirmedAt || site.placesConfiguredAt)
  );
}

class AppRoot extends HTMLElement {
  async connectedCallback() {
    if (this._isDevResetRoute()) {
      await this._resetFirstLaunch();
      return;
    }
    this._site = await getSite();
    this._onSitePlacesUpdated = (event) => {
      if (event.detail?.site) this._site = event.detail.site;
    };
    window.addEventListener("siteplacesupdated", this._onSitePlacesUpdated);
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
    if (this._onSitePlacesUpdated) {
      window.removeEventListener(
        "siteplacesupdated",
        this._onSitePlacesUpdated,
      );
    }
  }

  _renderSetup() {
    this.innerHTML = setupView();
    this.querySelector("site-setup").addEventListener("sitebound", async () => {
      this._site = await getSite();
      await this._refreshSiteSettings();
      this._renderApp();
      this._unsub = onRouteChange(() => this._renderView());
      navigate(this._hasPlaces() ? "/today" : "/places/setup");
      this._renderView();
    });
  }

  _renderApp() {
    this.innerHTML = appShell({ siteName: this._site.name });
    this._view = this.querySelector("#view");
    this._shell = this.querySelector(".app");
  }

  _renderView() {
    const route = currentRoute();
    if (this._isDevResetRoute(route)) {
      void this._resetFirstLaunch();
      return;
    }
    if (!this._hasPlaces() && !route.startsWith("/places/setup")) {
      navigate("/places/setup");
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

  async _refreshSiteSettings() {
    try {
      const { site } = await getSiteSettings();
      if (site) {
        const localPlaces = Array.isArray(this._site?.places)
          ? this._site.places
          : [];
        const remotePlaces = Array.isArray(site.places) ? site.places : [];
        this._site = await saveSiteSettings({
          ...site,
          places: remotePlaces.length ? remotePlaces : localPlaces,
          placesConfirmedAt:
            site.placesConfirmedAt ||
            site.placesConfiguredAt ||
            this._site?.placesConfirmedAt,
          providerSiteId: this._site.providerSiteId || site.providerSiteId,
        });
      }
    } catch (err) {
      console.error("getSiteSettings failed", err);
    }
  }

  _hasPlaces() {
    return hasConfirmedPlaces(this._site);
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
