// <admin-provider-page>: a provider record, one of its managers, or the new provider
// form. It owns its state and reads, so its tests fake only the provider calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { mixActions } from "../../mix-actions.js";
import {
  bindEnrollmentCodeExpiry,
  clearEnrollmentCodeView,
} from "../../enrollment-code-view.js";
import { syncEnrollmentRequests } from "../../enrollment-request.js";
import {
  hasDirtyForm,
  syncDirtyForm,
  syncProviderDetailsForm,
} from "../../form-state.js";
import { navigate } from "../../router.js";
import {
  providerEvents,
  syncAddProgramButton,
  syncRevokeButton,
} from "./provider.bindings.js";
import { loadManagersForSearch } from "../site/manager-directory-read.js";
import { providerActions } from "./provider.actions.js";
import { listenForControls, pageState } from "../page-events.js";
import { confirmDiscardChanges } from "../shared.templates.js";
import {
  newProviderView,
  providerManagerDetailView,
  providerView,
} from "./provider.templates.js";

/**
 * @typedef {{ name: string, id?: string, membershipId?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {AdminProviderPage & typeof providerActions} ProviderPageElement
 */

export class AdminProviderPage extends HTMLElement {
  constructor() {
    super();
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    // Bumped by open() and leave(), so a read or save from an earlier visit stops there.
    this.visit = 0;
    // The visit render() last drew, so a reattach on the same visit keeps the form.
    this.renderedVisit = -1;
    // render() draws this route, not the URL path, so a late redraw shows the right Provider.
    /** @type {Route | null} */
    this.route = null;
    this.state = pageState(this, {
      /** @type {any | null} */
      provider: null,
      /** @type {any[]} */
      providerManagers: [],
      /** @type {any[]} */
      providerManagerGrants: [],
      /** @type {any[]} */
      providerManagerEnrollments: [],
      /** @type {Record<string, string>} */
      providerManagerGrantErrors: {},
      /** @type {any[]} */
      people: [],
      siteSaveMessage: "",
      /** @type {any} */
      enrollmentCodeView: undefined,
    });
  }

  connectedCallback() {
    // Dialogs fire cancel and close on themselves without bubbling, so only capture sees them.
    this.stopListening = listenForControls(this, providerEvents, [
      "cancel",
      "close",
    ]);
    window.addEventListener("pagehide", this.clearEnrollmentCodes);
    // A shell redraw, such as sign-in hiding this page, reattaches it; a redraw would reset unsaved edits.
    if (this.renderedVisit !== this.visit) this.render();
  }

  disconnectedCallback() {
    this.stopListening?.();
    window.removeEventListener("pagehide", this.clearEnrollmentCodes);
  }

  // One-time codes are secrets, so they never outlive the page being hidden.
  clearEnrollmentCodes = () => {
    clearEnrollmentCodeView(this.state);
    this.querySelectorAll("[data-enrollment-code]").forEach((node) =>
      node.remove(),
    );
  };

  /**
   * Load what the route shows; false when a newer open() or leave() came first.
   * @param {Route} route
   * @returns {Promise<boolean>}
   */
  async open(route) {
    if (
      route.name === "provider-manager" &&
      !this.session.capabilities.manageProviderManagers
    ) {
      navigate("/sites", { replace: true });
      return false;
    }
    const visit = ++this.visit;
    this.route = route;
    // One-time codes from the last visit must not show on this one.
    clearEnrollmentCodeView(this.state);
    if (route.name === "provider-new") return true;
    // A provider record lists its Programs and offers other providers, so read both first.
    await this.catalog.ensure(START_UP_LISTS);
    if (visit !== this.visit) return false;
    return /** @type {ProviderPageElement} */ (this).loadProvider(
      route.id || "",
    );
  }

  /** Called by <admin-app> on route changes and when it drops pages. */
  leave() {
    this.visit++;
    this.route = null;
    // The page stays in memory after the user leaves, so drop the secret now.
    this.clearEnrollmentCodes();
  }

  /** <admin-app> asks this before any route change, to warn before edits are lost. */
  hasUnsavedChanges() {
    return hasDirtyForm(this);
  }

  /** Ask in this page's own dialog whether to drop its edits; true when the user discards. */
  confirmLeave() {
    return confirmDiscardChanges(this);
  }

  /** @param {Route} route */
  shows(route) {
    return (
      route.name === "provider-new" ||
      (["provider", "provider-manager"].includes(route.name) &&
        this.state.provider?.providerId === route.id)
    );
  }

  focusOnOpen() {
    queueMicrotask(() => this.querySelector("h1")?.focus());
    if (this.route?.name === "provider-new")
      void loadManagersForSearch(this.catalog);
  }

  render() {
    this.renderedVisit = this.visit;
    const route = this.route;
    if (!route || !this.shows(route)) {
      this.innerHTML = "";
      return;
    }
    this.innerHTML =
      route.name === "provider-new"
        ? newProviderView()
        : route.name === "provider"
          ? providerView(/** @type {any} */ (this.state))
          : providerManagerDetailView(this.state, route.membershipId);
    const details = this.querySelector("#provider-details-form");
    if (details instanceof HTMLFormElement) syncProviderDetailsForm(details);
    const record = this.querySelector("#provider-manager-record-form");
    if (record instanceof HTMLFormElement) syncDirtyForm(record, true);
    this.querySelectorAll("[data-revoke-provider-devices]").forEach((form) =>
      syncRevokeButton(/** @type {HTMLElement} */ (form)),
    );
    const programs = this.querySelector("#provider-program-form");
    if (programs instanceof HTMLElement) syncAddProgramButton(programs);
    // Without createEntities the user can't save these changes, so don't offer them.
    if (!this.session.capabilities.createEntities)
      this.querySelectorAll(
        'a[href="/sites/new"], a[href^="/programs/new"], [data-deactivate-provider], #provider-program-form',
      ).forEach((element) => element.remove());
    bindEnrollmentCodeExpiry(this, this.state);
    syncEnrollmentRequests(this);
  }

  /** Show an error in <admin-app>'s error line, which sits outside this page. @param {Error} error */
  reportError(error) {
    this.dispatchEvent(
      new CustomEvent("page-error", { bubbles: true, detail: error }),
    );
  }
}

mixActions(AdminProviderPage, providerActions);

customElements.define("admin-provider-page", AdminProviderPage);
