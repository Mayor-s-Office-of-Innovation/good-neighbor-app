import "../../frontend/src/styles/overlays.css";
import { syncEnrollmentRequests } from "./enrollment-request.js";
import {
  clearEnrollmentCodeView,
  bindEnrollmentCodeExpiry,
} from "./enrollment-code-view.js";
import { startErrorPresentation } from "../../frontend/src/components/error-notice.js";
import { mountConnectionBanner } from "../../frontend/src/components/connection-banner.js";
startErrorPresentation();
mountConnectionBanner();
import { localRoleEnabled, getLocalRole, setLocalRole } from "./local-role.js";
import "../../frontend/src/components/app-toasts.js";
import { complianceDraftAfterNavigation } from "./compliance-profile-draft.js";
import { bindPhoneExtensions } from "./phone-extension.js";
import "./icons.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import "@awesome.me/webawesome/dist/styles/layers.css";
import "@awesome.me/webawesome/dist/styles/native.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/number-input/number-input.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";

import {
  completeAdminLoginFromUrl,
  hasAdminSession,
  signOutAdmin,
  startAdminLogin,
} from "./services/admin-auth.js";
import { adminCatalog, START_UP_LISTS } from "./admin-catalog.js";
import { adminSession } from "./admin-session.js";
import { getAdminConfig } from "./config.js";
import { visibleRecords } from "./record-navigation.js";
import { escapeHtml, formatTimestamp } from "./dom.js";
import { currentRoute, navigate } from "./router.js";
import { canEditSite, canEditSiteManager } from "./site-permissions.js";
import { adminSettingsMenu } from "./pages/admin-user/admin-user.templates.js";
import "./pages/admin-user/admin-users-page.js";
import {
  discardChangesDialog,
  entityBreadcrumb,
} from "./pages/shared.templates.js";
import { siteManagerEditorView } from "./pages/site/manager.templates.js";
import {
  siteSectionNav,
  siteSectionView,
} from "./pages/site/record.templates.js";
import "./pages/directory/directory-page.js";
import "./pages/site/site-import-page.js";
import { activeSiteSection } from "./pages/site/site-section.js";
import "./pages/program/program-page.js";
import "./pages/provider/provider-page.js";
import "./pages/site/new-site-page.js";
import { syncSiteDetailsForm, trackDirtyForm } from "./form-state.js";
import { bindSiteManager } from "./pages/site/manager.bindings.js";
import {
  bindAddressLookup,
  bindSiteRecord,
} from "./pages/site/record.bindings.js";
import { bindSiteOversight } from "./pages/site/oversight.bindings.js";
import { bindSiteCompliance } from "./pages/site/compliance.bindings.js";
import { bindSiteAccess } from "./pages/site/access.bindings.js";

import { siteManagerActions } from "./pages/site/manager.actions.js";
import { siteOversightActions } from "./pages/site/oversight.actions.js";
import { siteRecordActions } from "./pages/site/record.actions.js";
import { siteComplianceActions } from "./pages/site/compliance.actions.js";
import { siteAccessActions } from "./pages/site/access.actions.js";
import { mixActions } from "./mix-actions.js";
/**
 * @typedef {import("./admin-types.js").AdminState} AdminState
 */

/**
 * The app's own fields plus getters for adminSession and adminCatalog, so
 * templates still read `state` while only those two modules change the lists.
 * @param {Record<string, any>} fields
 * @returns {AdminState}
 */
function adminState(fields) {
  const shared = {
    role: () => adminSession.role,
    capabilities: () => adminSession.capabilities,
    profile: () => adminSession.profile,
    providers: () => adminCatalog.providers,
    programs: () => adminCatalog.programs,
    oversightOptions: () => adminCatalog.oversightOptions,
    programManagers: () => adminCatalog.programManagers,
    sites: () => adminCatalog.sites,
    managerDirectoryLoaded: () => adminCatalog.managersLoaded,
  };
  for (const [name, get] of Object.entries(shared))
    Object.defineProperty(fields, name, { get, enumerable: true });
  return /** @type {AdminState} */ (fields);
}

// One tag per route, so routes that share a page reuse its loaded lists.
const ROUTE_PAGES = {
  administrators: "admin-users-page",
  "administrator-new": "admin-users-page",
  profile: "admin-users-page",
  "site-import": "admin-site-import-page",
  "site-new": "admin-new-site-page",
  sites: "admin-directory-page",
  managers: "admin-directory-page",
  providers: "admin-directory-page",
  programs: "admin-directory-page",
  "provider-managers": "admin-directory-page",
  provider: "admin-provider-page",
  "provider-new": "admin-provider-page",
  "provider-manager": "admin-provider-page",
};

class AdminApp extends HTMLElement {
  // One element per tag, reused on every visit, so a page keeps its lists between visits.
  /** @type {Record<string, any>} */
  routePages = {};

  /** The directory page's unsaved 311 edits, which the leave prompt checks. */
  get site311Batch() {
    return this.routePages["admin-directory-page"]?.state.site311Batch;
  }

  constructor() {
    super();
    /** @type {AdminState} */
    this.state = adminState({
      siteManagers: [],
      siteManager: null,
      provider: null,
      providerManagerGrants: [],
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
      error: "",
      hasToken: false,
      authConfig: getAdminConfig(),
      authBusy: false,
      complianceProfileDraft: null,
      perimeterSaving: false,
      perimeterMessage: "",
      perimeterError: "",
      revocationMessage: "",
      physicalDeviceRevocationPreview: null,
      emergencyRevocationSites: [],
      emergencyRevocationPreview: null,
      suspensionTarget: null,
      managerMembershipRemovalTarget: null,
    });
  }

  /** Pages outlive a render, so drop them with the session: their unsaved edits belong to it. */
  dropPages() {
    for (const page of [...Object.values(this.routePages), this.programPage])
      page?.leave();
    this.routePages = {};
    this.routePage = this.programPage = null;
  }

  /**
   * Initialize admin auth state and load provider data when signed in.
   * @returns {Promise<void>}
   */
  async connectedCallback() {
    // The manager list below starts empty again, so its loaded flag must too.
    adminCatalog.invalidate("managers");
    // A reattached app reads the role again, so a failed read can't keep the old one.
    adminSession.clear();
    this.dropPages();
    this.state = adminState({
      siteManagers: [],
      siteManager: null,
      provider: null,
      providerManagerGrants: [],
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
      error: "",
      hasToken: hasAdminSession(),
      authConfig: getAdminConfig(),
      authBusy: false,
      complianceProfileDraft: null,
      revocationMessage: "",
      physicalDeviceRevocationPreview: null,
      emergencyRevocationSites: [],
      emergencyRevocationPreview: null,
      suspensionTarget: null,
      managerMembershipRemovalTarget: null,
      perimeterSaving: false,
      perimeterMessage: "",
      perimeterError: "",
    });
    const callback = await completeAdminLoginFromUrl().catch((err) => ({
      handled: true,
      error: err.message,
    }));
    if (callback.handled) {
      this.state.hasToken = hasAdminSession();
      this.state.error = callback.error || "";
    }
    this.render();
    this.addEventListener("click", this.routeClick);
    this.addEventListener("page-error", this.showPageError);
    // Capture, since close doesn't bubble and the dialog may sit inside a page element.
    this.addEventListener("close", this.leaveDialogClosed, true);
    window.addEventListener("popstate", this.routeChanged);
    window.addEventListener("beforeunload", this.beforeUnload);
    window.addEventListener("pagehide", this.clearDisplayedEnrollmentCodes);
    if (this.state.hasToken) {
      const origin = location.pathname + location.search;
      this.bootstrap().catch((error) => {
        if (
          error.name === "AbortError" ||
          location.pathname + location.search !== origin
        )
          return;
        this.routeReadFailed = true;
        this.state.error = error.message;
        this.render();
      });
    }
  }

  disconnectedCallback() {
    clearEnrollmentCodeView(this.state);
    this.deviceRevocationController?.abort();
    this.directorySearchDebounce?.cancel();
    this.managerSearchCleanup?.();
    this.removeEventListener("click", this.routeClick);
    this.removeEventListener("page-error", this.showPageError);
    this.removeEventListener("close", this.leaveDialogClosed, true);
    window.removeEventListener("popstate", this.routeChanged);
    window.removeEventListener("beforeunload", this.beforeUnload);
    window.removeEventListener("pagehide", this.clearDisplayedEnrollmentCodes);
  }

  clearDisplayedEnrollmentCodes = () => {
    clearEnrollmentCodeView(this.state);
    this.querySelectorAll("[data-enrollment-code]").forEach((node) =>
      node.remove(),
    );
  };

  /** @param {Event} event */
  showPageError = (event) => {
    const { message } = /** @type {CustomEvent<Error>} */ (event).detail;
    // Pages clear the line after most actions; redrawing <admin-app> for no change loses focus.
    if (message === this.state.error) return;
    this.state.error = message;
    this.render();
  };

  /** @param {Event} event */
  leaveDialogClosed = (event) => {
    const dialog = event.target;
    if (
      !(dialog instanceof HTMLDialogElement) ||
      dialog.id !== "site-unsaved-dialog" ||
      this.programPage?.contains(dialog) ||
      dialog.returnValue !== "discard" ||
      !this.pendingSiteDestination
    )
      return;
    this.site311Batch?.drafts.clear();
    this.lastRenderedPath = "";
    navigate(this.pendingSiteDestination);
  };

  beforeUnload = (event) => {
    if (!this.hasUnsavedSiteChanges() && !this.shownPage()?.hasUnsavedChanges())
      return;
    event.preventDefault();
    event.returnValue = "";
  };

  routeClick = (event) => {
    const link = event.target.closest?.("a[data-route], button[data-navigate]");
    if (
      !link ||
      !this.contains(link) ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const destination =
      link.getAttribute("href") || link.dataset.navigate || "/sites";
    const page = this.shownPage();
    if (page?.hasUnsavedChanges()) void this.leavePage(page, destination);
    else if (this.hasUnsavedSiteChanges())
      this.confirmSiteNavigation(destination);
    else navigate(destination);
  };

  routeChanged = () => {
    this.navigationGeneration = (this.navigationGeneration || 0) + 1;
    this.deviceRevocationController?.abort();
    this.directorySearchDebounce?.cancel();
    this.managerSearchCleanup?.();
    const destination = window.location.pathname + window.location.search;
    const page = this.shownPage();
    const pageEdited = Boolean(page?.hasUnsavedChanges());
    if (
      this.lastRenderedPath &&
      destination !== this.lastRenderedPath &&
      !(
        this.lastRenderedPath.split("?")[0] === "/sites" &&
        currentRoute().name === "sites"
      ) &&
      (pageEdited || this.hasUnsavedSiteChanges())
    ) {
      window.history.pushState({}, "", this.lastRenderedPath);
      if (page && pageEdited) void this.leavePage(page, destination);
      else this.confirmSiteNavigation(destination);
      return;
    }
    clearEnrollmentCodeView(this.state);
    this.state.complianceProfileDraft = complianceDraftAfterNavigation(
      this.state.complianceProfileDraft,
      destination,
    );
    this.siteReadController?.abort();
    this.routeReadFailed = false;
    this.state.error = "";
    if (
      !(
        currentRoute().name === "system-status" &&
        this.querySelector("system-status-view")
      )
    )
      this.render(true);
    this.openRoute().catch((error) => {
      if (
        error.name === "AbortError" ||
        window.location.pathname + window.location.search !== destination
      )
        return;
      this.routeReadFailed = true;
      if (this.state.complianceProfileDraft?.phase === "returning")
        this.state.complianceProfileDraft.phase = "recovery";
      this.state.error = error.message;
      this.render();
    });
  };

  hasUnsavedSiteChanges() {
    if (this.site311Batch?.drafts.size || this.site311Batch?.saving)
      return true;
    if (this.querySelector("#admin-user-form[data-saving='true']")) return true;
    const siteDetailsForm = this.querySelector("#site-details-form");
    const siteDetailsDirty =
      siteDetailsForm instanceof HTMLFormElement
        ? syncSiteDetailsForm(siteDetailsForm)
        : false;
    return (
      siteDetailsDirty ||
      // The Program page answers for its own forms through hasUnsavedChanges().
      [
        ...this.querySelectorAll(
          "[data-dirty-form]:not(#site-details-form)[data-is-dirty='true']",
        ),
      ].some((form) => !form.closest("admin-program-page"))
    );
  }

  /** The page element on screen, if this route shows one. */
  shownPage() {
    return this.programPage?.isConnected ? this.programPage : null;
  }

  /**
   * Go to `destination` once the page's own dialog says its edits can be dropped.
   * @param {any} page
   * @param {string} destination
   */
  async leavePage(page, destination) {
    if (!(await page.confirmLeave()) || page !== this.shownPage()) return;
    // Skips routeChanged's guard, since the user just chose to drop the edits.
    this.lastRenderedPath = "";
    navigate(destination);
  }

  confirmSiteNavigation(destination) {
    // An invitation already in flight cannot be cancelled by leaving the page.
    if (this.querySelector("#admin-user-form[data-saving='true']")) return;
    if (this.site311Batch?.saving) return;
    this.pendingSiteDestination = destination;
    this.querySelector("#site-unsaved-dialog")?.showModal();
  }

  async saveAndLeaveSite() {
    const form = this.querySelector("[data-dirty-form][data-is-dirty='true']");
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const destination = this.pendingSiteDestination;
    let saved = false;
    if (form.id === "site-details-form") saved = await this.updateSite(form);
    if (form.id === "site-deliberate-311-form")
      saved = await this.updateSiteDeliberate311(form);
    if (form.id === "site-oversight-form")
      saved = await this.updateOversight(form);
    if (form.id === "site-compliance-form")
      saved = await this.createSiteTerms(form);
    if (form.id === "site-perimeter-form")
      saved = await this.updatePerimeter(form);
    if (form.id === "site-manager-record-form")
      saved = await this.saveSiteManager(form);
    if (saved && destination) navigate(destination);
  }

  async bootstrap() {
    this.routeReadFailed = false;
    await adminSession.load();
    this.render(true);
    await this.openRoute();
  }

  async openRoute() {
    const route = currentRoute();
    const path = location.pathname + location.search;
    // Dropped on leaving, so a later visit can't flash the last Program.
    if (!["program", "program-new"].includes(route.name)) {
      this.programPage?.leave();
      this.programPage = null;
    }
    // Pages stay alive between visits, so stop a read or save they started.
    for (const [tag, page] of Object.entries(this.routePages))
      if (tag !== ROUTE_PAGES[route.name]) page.leave();
    if (!ROUTE_PAGES[route.name]) this.routePage = null;
    const needsSites = ["manager", "manager-new"].includes(route.name);
    if (
      ![
        "system-status",
        // The Program page calls ensure() on the catalog createPage() gives it.
        "program",
        "program-new",
      ].includes(route.name) &&
      !ROUTE_PAGES[route.name]
    ) {
      await adminCatalog.ensure([
        ...START_UP_LISTS,
        ...(needsSites ? /** @type {const} */ (["sites"]) : []),
      ]);
      if (location.pathname + location.search !== path) return;
    }
    if (route.name === "program" || route.name === "program-new")
      return this.openProgramPage(route);
    if (
      route.name === "provider-manager" &&
      !this.state.capabilities.manageProviderManagers
    )
      return navigate("/sites", { replace: true });
    if (ROUTE_PAGES[route.name]) return this.openRoutePage(route);
    if (route.name === "system-status") {
      await import("./system-status.js");
      if (location.pathname + location.search !== path) return;
      if (!this.state.capabilities.manageAdminUsers)
        return navigate("/sites", { replace: true });
      const status = this.querySelector("system-status-view");
      if (status) {
        status.showView(route.id);
        this.lastRenderedPath = path;
        return;
      }
      this.state.provider = this.state.site = this.state.siteManager = null;
      this.render();
      this.querySelector("#status-title")?.focus();
      return;
    }
    if (route.name === "manager-new") {
      await this.loadSiteManagers();
      if (location.pathname + location.search !== path) return;
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      this.state.siteManager = null;
      this.state.provider = null;
      this.state.site = null;
      this.render();
      return;
    }
    if (route.name === "manager") return this.openSiteManager(route.id);
    if (location.pathname + location.search !== path) return;
    if (route.name === "site") return this.openSite(route.id, false, false);
    this.state.provider = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
    if (new URLSearchParams(location.search).get("q")?.trim())
      void this.loadSearchManagers();
  }

  /** @param {{ name: string, id?: string }} route */
  async openProgramPage(route) {
    const page = (this.programPage ||= /** @type {any} */ (
      this.createPage("admin-program-page")
    ));
    // A newer visit replaced the page, so this one must not render or focus.
    if (!(await page.open(route)) || page !== this.programPage) return;
    this.state.provider = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    page.focusOnOpen();
    if (
      route.name === "program-new" &&
      new URLSearchParams(location.search).get("q")?.trim()
    )
      void this.loadSearchManagers();
  }

  /** @param {{ name: string, id?: string }} route */
  async openRoutePage(route) {
    const tag = ROUTE_PAGES[route.name];
    const page = (this.routePages[tag] ||= this.createPage(tag));
    // My profile requires a phone while <admin-app> holds an unsaved Site compliance draft.
    page.complianceDraft = () => this.state.complianceProfileDraft;
    // Creating a Site makes a running Site manager read stale, so the next read starts over.
    page.dropManagerLoad = () => (this.managerDirectoryLoader = null);
    // <admin-app> still holds the Site manager list and its read; the directory page shows them.
    page.managers = () => this.state.siteManagers;
    page.loadManagers = () => this.loadSiteManagers();
    page.pathRendered = (path) => (this.lastRenderedPath = path);
    page.reopenRoute = () => this.openRoute();
    this.routePage = page;
    // A newer visit replaced the page, so this one must not render or focus.
    if (!(await page.open(route)) || page !== this.routePage) return;
    this.state.provider = this.state.site = this.state.siteManager = null;
    // Opening the invite form clears an error left from the admin users list.
    if (route.name === "administrator-new") this.state.error = "";
    this.render();
    page.focusOnOpen();
  }

  /** @param {string} tag */
  createPage(tag) {
    const page = /** @type {any} */ (document.createElement(tag));
    // The same lists and role as main.js's own pages, so a save on one page shows on the others.
    page.catalog = adminCatalog;
    page.session = adminSession;
    // A detached page's errors can't bubble up to <admin-app>, so pass them on.
    page.addEventListener("page-error", (event) => {
      if (!page.isConnected) this.showPageError(event);
    });
    return page;
  }

  /** Called when <admin-app>'s Site manager search read ends, so the directory page redraws its results. */
  renderDirectoryResults() {
    this.routePages["admin-directory-page"]?.renderDirectoryResults();
  }
  /** Reattach every page's listeners, since render() replaces this element's HTML. */
  bind() {
    bindEnrollmentCodeExpiry(this, this.state);
    this.querySelectorAll("[data-show-enrollment-code]").forEach((button) => {
      const scope = button.dataset.enrollmentScope;
      const membershipId = button.getAttribute("data-show-enrollment-code");
      button.addEventListener("click", () =>
        this.showEnrollmentCode(scope, membershipId),
      );
    });
    this.querySelector("#retry-page-load")?.addEventListener("click", () => {
      if (!this.state.role) {
        window.location.reload();
        return;
      }
      this.routeChanged();
    });
    this.querySelector("#local-role-switch")?.addEventListener(
      "change",
      (event) => {
        const select = event.currentTarget;
        if (
          this.querySelector("[data-is-dirty='true']") &&
          !window.confirm(t("admin.localRole.discard"))
        ) {
          select.value = getLocalRole();
          return;
        }
        setLocalRole(select.value);
        window.location.reload();
      },
    );
    bindPhoneExtensions(this);
    bindAddressLookup(this);
    this.querySelector("#sign-in")?.addEventListener("click", async () => {
      this.state.authBusy = true;
      this.state.error = "";
      this.render();
      await startAdminLogin().catch((err) => {
        this.state.authBusy = false;
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector("#clear-token")?.addEventListener("click", () => {
      this.state.hasToken = false;
      adminCatalog.clear();
      adminSession.clear();
      this.dropPages();
      this.state.provider = null;
      this.state.site = null;
      clearEnrollmentCodeView(this.state);
      signOutAdmin();
    });
    bindSiteManager(this);
    bindSiteRecord(this);
    bindSiteOversight(this);
    this.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
    this.querySelectorAll(
      "#site-oversight-form, #site-compliance-form, #site-perimeter-form, #site-manager-record-form, #site-deliberate-311-form",
    ).forEach((form) => trackDirtyForm(/** @type {HTMLFormElement} */ (form)));
    bindSiteCompliance(this);
    bindSiteAccess(this);
  }

  /**
   * Render the current admin application state.
   * @returns {void}
   */
  render(loading = false) {
    this.state.hasToken = hasAdminSession();
    this.directorySearchDebounce?.cancel();
    this.managerSearchCleanup?.();
    const route = currentRoute();
    const { site, siteManager } = loading
      ? {}
      : visibleRecords(this.state, route);
    // A signed-out user never saw the new Program form, only a Program record.
    const pageElement =
      !loading &&
      this.programPage?.shows(route) &&
      (route.name !== "program-new" || this.state.hasToken)
        ? this.programPage
        : !loading && this.state.hasToken && this.routePage?.shows(route)
          ? this.routePage
          : null;
    const siteSubview =
      new URLSearchParams(window.location.search).get("view") || "";
    const siteSection = activeSiteSection(
      new URLSearchParams(window.location.search).get("section"),
      this.state.capabilities,
    );
    this.innerHTML = `
      <main class="admin" id="main-content" tabindex="-1">
        <header class="admin__header">
          <div class="site-title">
            <a class="brand" href="/sites" data-route>${escapeHtml(t("admin.brand"))}</a>
          </div>
          ${
            this.state.hasToken
              ? adminSettingsMenu(
                  this.state.capabilities.manageAdminUsers,
                  this.state.capabilities.createEntities,
                )
              : ""
          }
        </header>
        ${localRoleEnabled(this.state.authConfig) ? `<div class="local-role-switch"><label for="local-role-switch">${escapeHtml(t("admin.localRole.label"))}</label><select id="local-role-switch"><option value="supervisor" ${getLocalRole() === "supervisor" ? "selected" : ""}>${escapeHtml(t("admin.localRole.supervisor"))}</option><option value="manager" ${getLocalRole() === "manager" ? "selected" : ""}>${escapeHtml(t("admin.localRole.manager"))}</option></select><p class="muted">${escapeHtml(t("admin.localRole.help"))}</p></div>` : ""}
        ${
          this.state.hasToken
            ? ""
            : `
              <section class="panel">
                <h2>Sign in</h2>
                <p class="muted">Use the City-managed admin sign-in to continue.</p>
                <button class="btn-primary" id="sign-in" type="button" ${this.state.authBusy ? "disabled" : ""}>
                  ${this.state.authBusy ? "Opening sign in..." : "Sign in with Cognito"}
                </button>
                ${
                  !this.state.authConfig.cognitoDomain ||
                  !this.state.authConfig.clientId
                    ? '<p class="error">Admin login is not configured for this environment.</p>'
                    : ""
                }
              </section>
            `
        }
        ${loading ? `<p role="status"><wa-spinner aria-hidden="true"></wa-spinner> ${escapeHtml(t("admin.status.loading"))}</p>` : ""}
        ${this.state.error ? `<p class="error">${escapeHtml(this.state.error)}</p>` : ""}
        ${this.routeReadFailed ? `<button class="btn-secondary" id="retry-page-load" type="button">${escapeHtml(t("common.retry"))}</button>` : ""}
        ${this.state.complianceProfileDraft?.phase === "recovery" ? `<button id="retry-compliance-draft" class="btn-secondary" type="button">${escapeHtml(t("admin.compliance.resumeDraft"))}</button>` : ""}
        ${
          this.state.hasToken && !loading && route.name === "system-status"
            ? this.state.capabilities.manageAdminUsers
              ? `<system-status-view view="${escapeHtml(route.id)}"></system-status-view>`
              : ""
            : ""
        }
        ${this.state.hasToken && !loading && route.name === "manager-new" ? siteManagerEditorView(this.state, null) : ""}
        ${pageElement ? "<template data-page-slot></template>" : ""}
        ${siteManager ? siteManagerEditorView(this.state, siteManager) : ""}
        ${
          site
            ? `
              <section class="site-page site-record">
                ${entityBreadcrumb("site", site, this.state.programs, this.state.providers)}
                <div class="panel__head">
                  <div class="site-title">
                    <h1 tabindex="-1">${escapeHtml(site.name)}</h1>
                    <p class="muted site-title__updated">
                      Last updated ${escapeHtml(formatTimestamp(site.updatedAt))}
                    </p>
                  </div>
                </div>
                ${siteSectionNav(site.siteId, siteSection, this.state.capabilities.createEntities === true)}
                ${siteSectionView(this.state, siteSection, siteSubview)}
                ${discardChangesDialog()}
              </section>
            `
            : ""
        }
      ${!site && !pageElement && route.name === "sites" ? discardChangesDialog() : ""}
      </main>
    `;
    this.bind();
    this.applyCapabilities();
    syncEnrollmentRequests(this);
    // Added last, so bind() and applyCapabilities() skip the page's own controls.
    if (pageElement)
      this.querySelector("template[data-page-slot]")?.replaceWith(pageElement);
    this.lastRenderedPath = window.location.pathname + window.location.search;
  }

  applyCapabilities() {
    const capabilities = this.state.capabilities;
    const editableSite = canEditSite(this.state);
    if (this.state.site && !editableSite) {
      this.querySelectorAll(
        '.site-page form input, .site-page form select, .site-page form textarea, .site-page form wa-input, .site-page form wa-select, .site-page form wa-textarea, .site-page form wa-checkbox, .site-page form wa-number-input, .site-page form button:not([data-close-dialog]):not([value="cancel"]):not([value="close"])',
      ).forEach((element) => {
        // Informational dialogs and their Close controls remain usable.
        if (!element.closest("#compliance-reasons-dialog"))
          element.disabled = true;
      });
      this.querySelectorAll(
        "[data-require-checks], [data-end-checks], [data-resend-letter], [data-issue-manager-grant], [data-show-enrollment-code], [data-cancel-manager-grant], [data-revoke-device], [data-remove-manager-membership], [data-remove-site-manager], [data-edit-manager-membership]",
      ).forEach((element) => {
        element.disabled = true;
      });
    }
    if (this.state.siteManager && !canEditSiteManager(this.state)) {
      this.querySelectorAll(
        "#site-manager-record-form input, #site-manager-record-form wa-input, #site-manager-record-form wa-select, #site-manager-record-form wa-checkbox, #site-manager-record-form button, #revoke-manager-devices input, #revoke-manager-devices wa-input, #revoke-manager-devices button",
      ).forEach((element) => {
        element.disabled = true;
      });
    }
    if (capabilities.createEntities) return;
    this.querySelectorAll(
      'a[href="/sites/new"], a[href^="/providers/new"], a[href^="/programs/new"], a[href="/managers/new"], a[href="/sites/import"], [data-deactivate-provider], [data-deactivate-site], [data-remove-site-manager], [data-save-lead-program], #provider-program-form, #new-city-program-manager-dialog',
    ).forEach((element) => element.remove());
    if (!editableSite)
      this.querySelectorAll(
        "[data-remove-manager-membership], [data-remove-site-manager], #manager-membership-form",
      ).forEach((element) => element.remove());
    const leadProvider = this.querySelector('[name="lead-provider-id"]');
    if (leadProvider) leadProvider.disabled = true;
    const leadProgram = this.querySelector('[name="lead-program-id"]');
    if (leadProgram) leadProgram.disabled = true;
  }
}

// Page actions use this.state and render(), so they live on AdminApp.
mixActions(
  AdminApp,
  siteManagerActions,
  siteOversightActions,
  siteRecordActions,
  siteComplianceActions,
  siteAccessActions,
);

customElements.define("admin-app", AdminApp);
