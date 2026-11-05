// <admin-new-site-page>: the new Site flow. It owns the new Site's people, so its
// tests fake only the Site create calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { mixActions } from "../../mix-actions.js";
import { listenForControls, pageView } from "../page-events.js";
import { newSiteEvents } from "./new.bindings.js";
import { newSiteActions } from "./new.actions.js";
import { bindAddressLookup } from "./record.bindings.js";
import { newSiteFlowView } from "./new.templates.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {NewSitePage & typeof newSiteActions} NewSitePageElement
 */

export class NewSitePage extends HTMLElement {
  constructor() {
    super();
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    /** @type {{ newSiteUsers: any[] }} */
    this.state = { newSiteUsers: [] };
    // Bumped by open() and leave(), so a save from an earlier visit doesn't navigate.
    this.visit = 0;
    // render() draws this route, not the URL path, so a late redraw shows the right page.
    /** @type {Route | null} */
    this.route = null;
    /** Set by <admin-app>, which holds the Site manager read a new Site makes stale. */
    this.dropManagerLoad = () => {};
  }

  connectedCallback() {
    this.stopListening = listenForControls(this, newSiteEvents);
    this.render();
  }

  disconnectedCallback() {
    this.stopListening?.();
  }

  /**
   * Load what the route shows; false when a newer open() or leave() came first.
   * @param {Route} route
   * @returns {Promise<boolean>}
   */
  async open(route) {
    const visit = ++this.visit;
    this.route = route;
    // The new Site flow picks from the Provider and Program lists, so read them first.
    await this.catalog.ensure(START_UP_LISTS);
    if (visit !== this.visit) return false;
    this.state.newSiteUsers = [];
    return this.shows(route);
  }

  /** <admin-app> calls this when the user goes to a route this page doesn't show. */
  leave() {
    this.visit++;
    this.route = null;
  }

  /** @param {Route} route */
  shows(route) {
    return route.name === "site-new";
  }

  focusOnOpen() {
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  render() {
    if (!this.route || !this.shows(this.route)) {
      this.innerHTML = "";
      return;
    }
    this.innerHTML = newSiteFlowView(pageView(this));
    // Marked once here, since the address lookup later drops required from the search field.
    this.querySelectorAll("#new-site-record-form [required]").forEach(
      (control) => {
        control.setAttribute("data-track-empty", "");
        control.toggleAttribute(
          "data-empty",
          !String(/** @type {any} */ (control).value || "").trim(),
        );
      },
    );
    // bindAddressLookup attaches to the new address fields after every render, as on the Site record.
    bindAddressLookup(/** @type {any} */ (this));
    // Hide create links from anyone who can't create records, as <admin-app> does.
    if (this.session.capabilities.createEntities) return;
    this.querySelectorAll(
      'a[href="/sites/new"], a[href^="/providers/new"], a[href^="/programs/new"]',
    ).forEach((link) => link.remove());
  }
}

mixActions(NewSitePage, newSiteActions);

customElements.define("admin-new-site-page", NewSitePage);
