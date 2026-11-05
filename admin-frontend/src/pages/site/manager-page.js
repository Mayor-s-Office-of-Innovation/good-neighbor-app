// The Site manager page: one manager's record, or the new manager form. It
// owns the manager being edited, so its tests fake only the manager calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { mixActions } from "../../mix-actions.js";
import { visibleRecords } from "../../record-navigation.js";
import { siteManagerEditorView } from "./manager.templates.js";
import { applySiteCapabilities } from "./site-capabilities.js";
import { listenForControls, pageState } from "../page-events.js";
import { pageMessages } from "./page-support.js";
import { prepareSiteManager, siteManagerEvents } from "./manager.bindings.js";
import {
  siteManagerActions,
  siteManagerRecordActions,
} from "./manager.actions.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {AdminSiteManagerPage & typeof pageMessages & typeof siteManagerRecordActions & Pick<typeof siteManagerActions, "fetchSiteManagers"> & { ownManagerRead: typeof siteManagerActions.loadSiteManagers }} ManagerPageElement
 */

export class AdminSiteManagerPage extends HTMLElement {
  constructor() {
    super();
    this.state = pageState(this, {
      siteManager: null,
      siteSaveMessage: "",
      siteSaveError: "",
    });
    /**
     * <admin-app> sets this to the managers directory's read, so a visit never reads twice.
     * @type {((force?: boolean) => Promise<void>) | null}
     */
    this.loadManagers = null;
    // Bumped by open() and leave(), so a read or save from an earlier visit stops there.
    this.visit = 0;
    // The visit render() last drew, so a reattach on the same visit keeps the form.
    this.renderedVisit = -1;
    // render() draws this route, not the URL, so a late redraw shows the right Site manager.
    /** @type {Route | null} */
    this.route = null;
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
  }

  /** @param {boolean} [force] */
  loadSiteManagers(force) {
    const page = /** @type {ManagerPageElement} */ (this);
    return this.loadManagers
      ? this.loadManagers(force)
      : page.ownManagerRead(force);
  }

  connectedCallback() {
    // Captured, so events that don't bubble still reach their control; manager controls nest, so every match runs.
    this.stopListening = listenForControls(
      this,
      siteManagerEvents,
      Object.keys(siteManagerEvents),
      true,
    );
    // <admin-app>'s render() reattaches this page; redrawing it then would reset unsaved form edits.
    if (this.renderedVisit !== this.visit) this.render();
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
    // The manager form picks a Provider, Programs and Sites, and its breadcrumb names them.
    await this.catalog.ensure([...START_UP_LISTS, "sites"]);
    if (visit !== this.visit) return false;
    const page = /** @type {ManagerPageElement} */ (this);
    if (route.name === "manager") return page.openSiteManager(route.id || "");
    await page.loadSiteManagers();
    if (visit !== this.visit) return false;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.siteManager = null;
    return true;
  }

  /** <admin-app> calls this when the user goes to a route this page doesn't show. */
  leave() {
    this.visit++;
    this.route = null;
  }

  /** @param {Route} route */
  shows(route) {
    return (
      route.name === "manager-new" ||
      Boolean(this.managerOn(route)) ||
      // Drawn empty once, so focusOnOpen() can show "Site manager not found." in <admin-app>.
      (route.name === "manager" && this.managerMissing === true)
    );
  }

  /** @param {Route} route */
  managerOn(route) {
    return visibleRecords(this.state, route).siteManager;
  }

  focusOnOpen() {
    if (this.route?.name !== "manager") return;
    if (this.managerMissing) {
      this.managerMissing = false;
      this.reportError(new Error("Site manager not found."));
    }
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  render() {
    this.renderedVisit = this.visit;
    const route = this.route;
    const manager = route && this.managerOn(route);
    if (route?.name !== "manager-new" && !manager) {
      this.innerHTML = "";
      return;
    }
    this.innerHTML = siteManagerEditorView(this.state, manager);
    prepareSiteManager(/** @type {ManagerPageElement} */ (this));
    applySiteCapabilities(this, this.state);
    this.reportPath(location.pathname + location.search);
  }
}

mixActions(AdminSiteManagerPage, pageMessages, siteManagerRecordActions, {
  // Used when no <admin-app> sets loadManagers, as in page tests.
  ownManagerRead: siteManagerActions.loadSiteManagers,
  fetchSiteManagers: siteManagerActions.fetchSiteManagers,
});

customElements.define("admin-site-manager-page", AdminSiteManagerPage);
