// <admin-site-import-page>: the Site import page. It owns the preview, result and
// past imports, so its tests fake only the import calls.
import { mixActions } from "../../mix-actions.js";
import { listenForControls } from "../page-events.js";
import { siteImportEvents } from "./import.bindings.js";
import { siteImportActions } from "./import.actions.js";
import { siteImportView } from "./import.templates.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {SiteImportPage & typeof siteImportActions} SiteImportPageElement
 */

export class SiteImportPage extends HTMLElement {
  constructor() {
    super();
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    /** @type {{ importPreview: any | null, importResult: any | null, importBusy: boolean, importApplyKey: string, importHistory: any[], importNotice: { title: string, message: string } | null }} */
    this.state = {
      importPreview: null,
      importResult: null,
      importBusy: false,
      importApplyKey: "",
      importHistory: [],
      importNotice: null,
    };
    this.focusHeading = true;
    // Bumped by open() and leave(), so a read from an earlier visit stops there.
    this.visit = 0;
    // render() draws this route, not the URL, so a late redraw shows the right page.
    /** @type {Route | null} */
    this.route = null;
    // An apply outlives visits, so it redraws only while the page is on screen.
    this.showing = false;
  }

  connectedCallback() {
    this.stopListening = listenForControls(this, siteImportEvents);
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
    this.visit++;
    this.route = route;
    this.showing = this.shows(route);
    if (!this.showing) return false;
    return /** @type {SiteImportPageElement} */ (this).openSiteImport();
  }

  /** <admin-app> calls this when the user goes to a route this page doesn't show. */
  leave() {
    this.visit++;
    this.route = null;
    this.showing = false;
  }

  /** @param {Route} route */
  shows(route) {
    return route.name === "site-import";
  }

  focusOnOpen() {
    if (this.focusHeading)
      queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  render() {
    this.innerHTML =
      this.route && this.shows(this.route)
        ? siteImportView(/** @type {any} */ (this.state))
        : "";
  }

  /** Show an error in <admin-app>'s error line, which sits outside this page. @param {Error} error */
  reportError(error) {
    this.dispatchEvent(
      new CustomEvent("page-error", { bubbles: true, detail: error }),
    );
  }

  /** Clear <admin-app>'s error line, as a new preview or a cancel always has. */
  clearPageError() {
    this.reportError(new Error(""));
  }
}

mixActions(SiteImportPage, siteImportActions);

customElements.define("admin-site-import-page", SiteImportPage);
