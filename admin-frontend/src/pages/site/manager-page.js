// The Site manager page: one manager's record, or the new manager form. It
// owns the manager being edited, so its tests fake only the manager calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { mixActions } from "../../mix-actions.js";
import { visibleRecords } from "../../record-navigation.js";
import { hasDirtyForm } from "../../form-state.js";
import { siteManagerEditorView } from "./manager.templates.js";
import { applySiteCapabilities } from "./site-capabilities.js";
import { listenForControls, pageState } from "../page-events.js";
import { confirmDiscardChanges } from "../shared.templates.js";
import { pageMessages } from "./page-support.js";
import { prepareSiteManager, siteManagerEvents } from "./manager.bindings.js";
import { siteManagerRecordActions } from "./manager.actions.js";
import { loadManagers } from "./manager-directory-read.js";
import { appMessageError } from "../../admin-error-messages.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {AdminSiteManagerPage & typeof pageMessages & typeof siteManagerRecordActions} ManagerPageElement
 */

export class AdminSiteManagerPage extends HTMLElement {
  constructor() {
    super();
    this.state = pageState(this, {
      siteManager: null,
      siteSaveMessage: "",
      siteSaveError: "",
    });
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

  /** The directory page shares this manager read, so a visit never reads it twice. @param {boolean} [force] */
  loadSiteManagers(force) {
    return loadManagers(this.catalog, force);
  }

  connectedCallback() {
    // Captured, so events that don't bubble still reach their control; manager controls nest, so every match runs.
    this.stopListening = listenForControls(
      this,
      siteManagerEvents,
      Object.keys(siteManagerEvents),
      true,
    );
    // A shell redraw, such as sign-in hiding this page, reattaches it; a redraw would reset unsaved edits.
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

  /** Called by <admin-app> on route changes and when it drops pages. */
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

  /** <admin-app> asks this before any route change, to warn before edits are lost. */
  hasUnsavedChanges() {
    return hasDirtyForm(this);
  }

  /** Ask in this page's own dialog whether to drop its edits; true when the user discards. */
  confirmLeave() {
    return confirmDiscardChanges(this);
  }

  focusOnOpen() {
    if (this.route?.name !== "manager") return;
    if (this.managerMissing) {
      this.managerMissing = false;
      this.reportError(appMessageError("Site manager not found."));
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

mixActions(AdminSiteManagerPage, pageMessages, siteManagerRecordActions);

customElements.define("admin-site-manager-page", AdminSiteManagerPage);
