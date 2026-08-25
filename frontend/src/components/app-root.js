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
  ["/problem/describe", "describe-instead"],
  ["/problem", "problem-report"],
  ["/check/describe", "describe-instead"],
  ["/check", "perimeter-check"],
  ["/review", "check-review"],
  ["/results", "check-results"],
  ["/today", "today-view"],
];

if (import.meta.env.DEV) {
  ROUTE_VIEW.unshift(["/dev/guidance-harness", "guidance-harness"]);
}

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
    this._shell = this.querySelector(".app");
  }

  _renderView() {
    const route = currentRoute();
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
}
customElements.define("app-root", AppRoot);
