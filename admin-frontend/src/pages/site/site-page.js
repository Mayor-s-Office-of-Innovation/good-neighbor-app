// The Site page: a Site record and its tabs. It owns the Site and its tab
// data, so its tests fake only the Site's calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { mixActions } from "../../mix-actions.js";
import { escapeHtml, formatTimestamp } from "../../dom.js";
import { hasDirtyForm, syncSiteDetailsForm } from "../../form-state.js";
import {
  bindEnrollmentCodeExpiry,
  clearEnrollmentCodeView,
} from "../../enrollment-code-view.js";
import { syncEnrollmentRequests } from "../../enrollment-request.js";
import {
  confirmDiscardChanges,
  discardChangesDialog,
  entityBreadcrumb,
} from "../shared.templates.js";
import { siteSectionNav, siteSectionView } from "./record.templates.js";
import { bindAddressLookup } from "./address-lookup.js";
import { bindManagerAssignmentSearch } from "./manager-assignment-search.js";
import { applySiteCapabilities } from "./site-capabilities.js";
import { listenForControls, pageState } from "../page-events.js";
import { mergeEvents, pageMessages } from "./page-support.js";
import {
  prepareSiteRecord,
  prepareTrackedForms,
  siteRecordEvents,
} from "./record.bindings.js";
import {
  prepareSiteOversight,
  siteOversightEvents,
} from "./oversight.bindings.js";
import {
  prepareSiteCompliance,
  siteComplianceEvents,
} from "./compliance.bindings.js";
import { prepareSiteAccess, siteAccessEvents } from "./access.bindings.js";
import { siteManagerAccessEvents } from "./manager.bindings.js";
import { insightsOn } from "../insights/insights-page.js";
import { routeMode, safeReturnPath } from "../insights/insights-routes.js";
import { insightsReturnLink } from "../insights/shell.templates.js";
import { currentSiteSection, siteRecordActions } from "./record.actions.js";
import { siteOversightActions } from "./oversight.actions.js";
import { siteComplianceActions } from "./compliance.actions.js";
import { siteAccessActions } from "./access.actions.js";
import { siteManagerAccessActions } from "./manager.actions.js";
import { enrollmentCodeActions } from "../enrollment-code.actions.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {AdminSitePage & typeof pageMessages & typeof siteRecordActions & typeof siteOversightActions & typeof siteComplianceActions & typeof siteAccessActions & typeof siteManagerAccessActions & typeof enrollmentCodeActions} SitePageElement
 */

const siteEvents = mergeEvents(
  siteRecordEvents,
  siteOversightEvents,
  siteComplianceEvents,
  siteAccessEvents,
  siteManagerAccessEvents,
);

export class AdminSitePage extends HTMLElement {
  constructor() {
    super();
    this.state = pageState(this, {
      site: null,
      assignedUsers: [],
      assignedComplianceManagers: [],
      availableSiteUsers: [],
      siteTerms: [],
      letterEmailHistory: [],
      letterEmailUncertain: false,
      managerMemberships: [],
      managerGrants: [],
      devices: [],
      issuedCode: null,
      siteSaveMessage: "",
      siteSaveError: "",
      siteSaving: false,
      perimeterSaving: false,
      perimeterMessage: "",
      perimeterError: "",
      revocationMessage: "",
      managerMembershipRemovalTarget: null,
    });
    // Bumped by open() and leave(), so a read or save from an earlier visit stops there.
    this.visit = 0;
    // render() draws this route, not the URL, so a late redraw shows the right Site.
    /** @type {Route | null} */
    this.route = null;
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    /** @type {{ siteId: string, path: string } | null} */
    this.insightsReturn = null;
  }

  connectedCallback() {
    // Captured, so events that don't bubble still reach their control; Site controls nest, so every match runs.
    this.stopListening = listenForControls(
      this,
      siteEvents,
      Object.keys(siteEvents),
      true,
    );
    window.addEventListener("pagehide", this.clearDisplayedEnrollmentCodes);
    // A shell redraw reattaches this page on the same visit; redrawing would lose unsaved edits.
    if (this.renderedVisit !== this.visit) this.render();
  }

  disconnectedCallback() {
    this.stopListening?.();
    window.removeEventListener("pagehide", this.clearDisplayedEnrollmentCodes);
    // A shell redraw reattaches this page at once; only a real removal stops its work.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.deviceRevocationController?.abort();
      this.managerSearchCleanup?.();
      clearEnrollmentCodeView(this.state);
    });
  }

  /** Codes on screen are secrets, so they go when the browser hides the page. */
  clearDisplayedEnrollmentCodes = () => {
    clearEnrollmentCodeView(this.state);
    this.querySelectorAll("[data-enrollment-code]").forEach((node) =>
      node.remove(),
    );
  };

  /** Stop the last visit's reads, device revocation prompt and manager search. */
  endVisit() {
    this.visit++;
    this.siteReadController?.abort();
    this.deviceRevocationController?.abort();
    this.managerSearchCleanup?.();
    clearEnrollmentCodeView(this.state);
  }

  /** Drops the open Site unless the move is to Insights, so the Manage tab reopens it without a reread. @param {Route} [next] */
  leave(next) {
    this.endVisit();
    this.insightsReturn = null;
    // <admin-app> also leaves this page on the way back from Insights, with this Site as `next`.
    const back = next?.name === "site" && next.id === this.state.site?.siteId;
    if (routeMode(next?.name || "") !== "insights" && !back)
      this.state.site = null;
    this.route = null;
  }

  /** <admin-app> asks this before any route change, to warn before edits are lost. */
  hasUnsavedChanges() {
    const details = this.querySelector("#site-details-form");
    // syncSiteDetailsForm() sets data-is-dirty from the edited sections, so read it fresh.
    if (details instanceof HTMLFormElement) syncSiteDetailsForm(details);
    return hasDirtyForm(this);
  }

  /** Ask in this page's own dialog whether to drop its edits; true when the user discards. */
  confirmLeave() {
    return confirmDiscardChanges(this);
  }

  /**
   * Load what the route shows; false when a newer open() or leave() came first.
   * @param {Route} route
   * @returns {Promise<boolean>}
   */
  async open(route) {
    this.noteInsightsReturn(route.id || "");
    this.endVisit();
    this.route = route;
    const visit = this.visit;
    // The Site's breadcrumb, Provider and Program pickers and oversight lists need START_UP_LISTS.
    await this.catalog.ensure(START_UP_LISTS);
    if (visit !== this.visit) return false;
    const page = /** @type {SitePageElement} */ (this);
    return (await page.openSite(route.id || "", false, false, false)) === true;
  }

  /** Kept per Site, since saves and section links drop the return query. @param {string} siteId */
  noteInsightsReturn(siteId) {
    const path = safeReturnPath(
      new URLSearchParams(location.search).get("return"),
    );
    if (path) this.insightsReturn = { siteId, path };
    else if (this.insightsReturn?.siteId !== siteId) this.insightsReturn = null;
  }

  /** @param {string} siteId @returns {string} */
  insightsReturnPath(siteId) {
    return insightsOn(this.session) && this.insightsReturn?.siteId === siteId
      ? this.insightsReturn.path
      : "";
  }

  /** @param {Route} route */
  shows(route) {
    return route.name === "site" && this.state.site?.siteId === route.id;
  }

  focusOnOpen() {
    /** @type {SitePageElement} */ (this).revealSite(
      currentSiteSection(this.session),
      true,
    );
  }

  render() {
    this.renderedVisit = this.visit;
    this.managerSearchCleanup?.();
    const site = this.route && this.shows(this.route) ? this.state.site : null;
    if (!site) {
      this.innerHTML = "";
      return;
    }
    const activeSiteSection = currentSiteSection(this.session);
    const siteSubview =
      new URLSearchParams(window.location.search).get("view") || "";
    this.innerHTML = `
      <section class="site-page site-record">
        ${insightsReturnLink(this.insightsReturnPath(site.siteId))}
        ${entityBreadcrumb("site", site, this.state.programs, this.state.providers)}
        <div class="panel__head">
          <div class="site-title">
            <h1 tabindex="-1">${escapeHtml(site.name)}</h1>
            <p class="muted site-title__updated">
              Last updated ${escapeHtml(formatTimestamp(site.updatedAt))}
            </p>
          </div>
        </div>
        ${siteSectionNav(site.siteId, activeSiteSection, this.state.capabilities.createEntities === true)}
        ${siteSectionView(this.state, activeSiteSection, siteSubview)}
        ${discardChangesDialog()}
      </section>
    `;
    bindEnrollmentCodeExpiry(this, this.state);
    bindAddressLookup(this);
    this.managerSearchCleanup = bindManagerAssignmentSearch(
      this.querySelector("#manager-membership-form"),
    );
    const page = /** @type {SitePageElement} */ (this);
    prepareSiteRecord(page);
    prepareSiteOversight(page);
    prepareTrackedForms(page);
    prepareSiteCompliance(page);
    prepareSiteAccess(page);
    this.applyCapabilities();
    syncEnrollmentRequests(this);
    page.reportPath(location.pathname + location.search);
  }

  applyCapabilities() {
    applySiteCapabilities(this, this.state);
  }
}

mixActions(
  AdminSitePage,
  pageMessages,
  siteRecordActions,
  siteOversightActions,
  siteComplianceActions,
  siteAccessActions,
  siteManagerAccessActions,
  enrollmentCodeActions,
);

customElements.define("admin-site-page", AdminSitePage);
