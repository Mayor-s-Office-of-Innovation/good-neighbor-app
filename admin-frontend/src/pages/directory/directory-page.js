// <admin-directory-page>: the Sites, Site managers, Provider managers, Providers and
// Programs lists and their search. It owns the Provider manager list and unsaved 311 edits.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { adminApi } from "../../services/admin-api.js";
import { mixActions } from "../../mix-actions.js";
import { loadProviderManagerDirectory } from "../../provider-manager-directory.js";
import { navigate } from "../../router.js";
import { discardChangesDialog } from "../shared.templates.js";
import { listenForControls, pageView } from "../page-events.js";
import { directoryEvents } from "./directory.bindings.js";
import { directoryActions } from "./directory.actions.js";
import { directoryView } from "./directory.templates.js";
import { create311Batch, sync311Batch } from "./site-311-batch.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {DirectoryPage & typeof directoryActions} DirectoryPageElement
 */

const ROUTES = [
  "sites",
  "managers",
  "providers",
  "programs",
  "provider-managers",
];

export class DirectoryPage extends HTMLElement {
  constructor() {
    super();
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    /** @type {{ managerSearchFailed: boolean, providerManagerDirectory: any[] | undefined, site311Batch: ReturnType<typeof create311Batch> }} */
    this.state = {
      managerSearchFailed: false,
      providerManagerDirectory: undefined,
      site311Batch: create311Batch(),
    };
    // Bumped by open() and leave(), so a read from an earlier visit stops there.
    this.visit = 0;
    // render() draws this route, not the URL path, so a late redraw shows the right page.
    /** @type {Route | null} */
    this.route = null;
    this.composing = false;
    /** @type {{ schedule: () => void, cancel: () => void } | null} */
    this.directorySearchDebounce = null;
    // Set by <admin-app>, which still holds the Site manager list and its read.
    // Without <admin-app>, the page shows no Site managers.
    /** @type {() => any[]} */
    this.managers = () => [];
    /** @type {() => Promise<void>} */
    this.loadManagers = async () => {};
    /** Set by <admin-app>, whose unsaved-changes prompt needs the URL on screen. @type {(path: string) => void} */
    this.pathRendered = () => {};
  }

  connectedCallback() {
    this.stopListening = listenForControls(this, directoryEvents);
    this.render();
  }

  disconnectedCallback() {
    this.directorySearchDebounce?.cancel();
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
    const left = () => visit !== this.visit;
    // A failed Site manager read from an earlier visit mustn't show on this one.
    this.state.managerSearchFailed = false;
    // The lists show Sites with their Provider, Program and oversight, so read those first.
    await this.catalog.ensure([...START_UP_LISTS, "sites"]);
    if (left()) return false;
    if (route.name === "provider-managers") {
      if (!this.session.capabilities.manageProviderManagers) {
        navigate("/sites", { replace: true });
        return false;
      }
      const directory = await loadProviderManagerDirectory(
        this.catalog.providers,
        adminApi,
      );
      if (left()) return false;
      this.state.providerManagerDirectory = directory;
    }
    if (
      route.name === "managers" &&
      !new URLSearchParams(location.search).get("q")?.trim()
    )
      await this.loadManagers();
    return !left();
  }

  /** <admin-app> calls this when the user goes to a route this page doesn't show. */
  leave() {
    this.visit++;
    this.route = null;
  }

  /** @param {Route} route */
  shows(route) {
    return ROUTES.includes(route.name);
  }

  /** A ?q= search also lists Site managers, which open() doesn't read. */
  focusOnOpen() {
    queueMicrotask(() => this.querySelector("h1")?.focus());
    if (new URLSearchParams(location.search).get("q")?.trim())
      void (/** @type {DirectoryPageElement} */ (this).loadSearchManagers());
  }

  /** @returns {boolean} */
  managersLoaded() {
    return this.catalog.managersLoaded;
  }

  /** directoryView() also lists the Site managers <admin-app> still holds. */
  view() {
    return pageView(this, { siteManagers: () => this.managers() });
  }

  render() {
    this.directorySearchDebounce?.cancel();
    this.composing = false;
    const route = this.route;
    if (!route || !this.shows(route)) {
      this.innerHTML = "";
      return;
    }
    // The discard dialog lets the Sites list ask before dropping unsaved 311 edits.
    this.innerHTML = `${directoryView(this.view(), /** @type {any} */ (route))}${route.name === "sites" ? discardChangesDialog() : ""}`;
    sync311Batch(this, this.view());
    this.applyCapabilities();
  }

  /** Hide create links from anyone who can't create records, as <admin-app> does. */
  applyCapabilities() {
    if (this.session.capabilities.createEntities) return;
    this.querySelectorAll(
      'a[href="/sites/new"], a[href^="/providers/new"], a[href^="/programs/new"], a[href="/managers/new"], a[href="/sites/import"]',
    ).forEach((element) => element.remove());
  }
}

mixActions(DirectoryPage, directoryActions);

customElements.define("admin-directory-page", DirectoryPage);
