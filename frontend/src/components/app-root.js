// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  app-root — the shell. Enforces first-run site setup, renders the header, and swaps
  the main view based on the hash route. Everything is scoped to the bound site.

  Routes → views: /today → today-view, /check → perimeter-check, /review →
  check-review, /results → check-results. Setup (device→site binding) is retained and
  gates everything (see docs/take5-plan.md).
*/
import { getSite } from "../db.js";
import { currentRoute, onRouteChange, navigate } from "../router.js";
import { setupView, appShell } from "./app-root.templates.js";

const ROUTE_VIEW = [
  ["/check", "perimeter-check"],
  ["/review", "check-review"],
  ["/results", "check-results"],
  ["/today", "today-view"],
];

class AppRoot extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    if (!this._site) {
      this._renderSetup();
      return;
    }
    this._renderApp();
    this._unsub = onRouteChange(() => this._renderView());
    this._renderView();
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
  }

  _renderSetup() {
    this.innerHTML = setupView();
    this.querySelector("site-setup").addEventListener("sitebound", async () => {
      this._site = await getSite();
      this._renderApp();
      this._unsub = onRouteChange(() => this._renderView());
      navigate("/today");
      this._renderView();
    });
  }

  _renderApp() {
    this.innerHTML = appShell({ siteName: this._site.name });
    this._view = this.querySelector("#view");
  }

  _renderView() {
    const route = currentRoute();
    const match = ROUTE_VIEW.find(([prefix]) => route.startsWith(prefix));
    const tag = match ? match[1] : "today-view";
    // Always mount a fresh element (each screen reads current state on connect).
    this._view.replaceChildren(document.createElement(tag));
    this._view.focus();
  }
}
customElements.define("app-root", AppRoot);
