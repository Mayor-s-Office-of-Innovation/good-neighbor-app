import "../../frontend/src/styles/overlays.css";
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
import { adminCatalog } from "./admin-catalog.js";
import { adminSession } from "./admin-session.js";
import { getAdminConfig } from "./config.js";
import { escapeHtml } from "./dom.js";
import { currentRoute, navigate } from "./router.js";
import { canEditSite } from "./site-permissions.js";
import { adminSettingsMenu } from "./pages/admin-user/admin-user.templates.js";
import "./pages/admin-user/admin-users-page.js";
import { discardChangesDialog } from "./pages/shared.templates.js";
import "./pages/directory/directory-page.js";
import "./pages/site/site-import-page.js";
import "./pages/program/program-page.js";
import "./pages/provider/provider-page.js";
import "./pages/site/new-site-page.js";
import "./pages/site/site-page.js";
import "./pages/site/manager-page.js";
import { syncSiteDetailsForm } from "./form-state.js";
import { pageState } from "./pages/page-events.js";

import { siteManagerActions } from "./pages/site/manager.actions.js";
import { mixActions } from "./mix-actions.js";
/**
 * @typedef {import("./admin-types.js").AdminState} AdminState
 */

/** @param {Record<string, any>} fields */
const adminState = (fields) =>
  pageState({ catalog: adminCatalog, session: adminSession }, fields);

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
  // siteManagerActions, mixed in below, read Site managers from this.catalog, as the Site pages do.
  catalog = adminCatalog;

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
      provider: null,
      providerManagerGrants: [],
      error: "",
      hasToken: false,
      authConfig: getAdminConfig(),
      authBusy: false,
    });
  }

  /** Pages outlive a render, so drop them with the session: their unsaved edits belong to it. */
  dropPages() {
    for (const page of [
      ...Object.values(this.routePages),
      this.programPage,
      this.sitePage,
      this.managerPage,
    ])
      page?.leave();
    this.routePages = {};
    this.routePage = this.programPage = null;
    this.sitePage = this.managerPage = null;
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
      provider: null,
      providerManagerGrants: [],
      error: "",
      hasToken: hasAdminSession(),
      authConfig: getAdminConfig(),
      authBusy: false,
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
    this.addEventListener("page-rendered", this.pageRendered);
    this.addEventListener("draft-recovery", this.draftRecovery);
    // Capture, since close doesn't bubble and the dialog may sit inside a page element.
    this.addEventListener("close", this.leaveDialogClosed, true);
    window.addEventListener("popstate", this.routeChanged);
    window.addEventListener("beforeunload", this.beforeUnload);
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
    this.directorySearchDebounce?.cancel();
    this.removeEventListener("click", this.routeClick);
    this.removeEventListener("page-error", this.showPageError);
    this.removeEventListener("page-rendered", this.pageRendered);
    this.removeEventListener("draft-recovery", this.draftRecovery);
    this.removeEventListener("close", this.leaveDialogClosed, true);
    window.removeEventListener("popstate", this.routeChanged);
    window.removeEventListener("beforeunload", this.beforeUnload);
  }

  /** The Site page couldn't reopen the compliance draft, so show the button that retries it. */
  draftRecovery = () => this.render();

  /** @param {Event} event */
  showPageError = (event) => {
    const { message } = /** @type {CustomEvent<Error>} */ (event).detail;
    // Pages clear the line after most actions; redrawing <admin-app> for no change loses focus.
    if (message === this.state.error) return;
    this.state.error = message;
    this.render();
  };

  /** The Site and manager pages redraw on their own, so they report their path for the unsaved-changes check. @param {Event} event */
  pageRendered = (event) => {
    this.lastRenderedPath = /** @type {CustomEvent<string>} */ (event).detail;
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
    this.directorySearchDebounce?.cancel();
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
    adminSession.complianceDraft = complianceDraftAfterNavigation(
      adminSession.complianceDraft,
      destination,
    );
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
      if (adminSession.complianceDraft?.phase === "returning")
        adminSession.complianceDraft.phase = "recovery";
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
    // The Site page is reused on the next Site visit; leave() stops its reads and drops the Site.
    if (route.name !== "site") this.sitePage?.leave();
    if (!["manager", "manager-new"].includes(route.name)) {
      this.managerPage?.leave();
      this.managerPage = null;
    }
    if (route.name === "program" || route.name === "program-new")
      return this.openProgramPage(route);
    if (
      route.name === "provider-manager" &&
      !this.state.capabilities.manageProviderManagers
    )
      return navigate("/sites", { replace: true });
    if (ROUTE_PAGES[route.name]) return this.openRoutePage(route);
    if (route.name === "site") return this.openSitePage(route);
    if (route.name === "manager" || route.name === "manager-new")
      return this.openManagerPage(route);
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
      this.state.provider = null;
      this.render();
      this.querySelector("#status-title")?.focus();
      return;
    }
  }

  /** @param {{ name: string, id?: string }} route */
  async openProgramPage(route) {
    const page = (this.programPage ||= /** @type {any} */ (
      this.createPage("admin-program-page")
    ));
    // A newer visit replaced the page, so this one must not render or focus.
    if (!(await page.open(route)) || page !== this.programPage) return;
    this.state.provider = null;
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
    page.complianceDraft = () => adminSession.complianceDraft;
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
    this.state.provider = null;
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

  /** @param {{ name: string, id?: string }} route */
  async openSitePage(route) {
    const page = (this.sitePage ||= /** @type {any} */ (
      this.createPage("admin-site-page")
    ));
    if (!(await page.open(route)) || page !== this.sitePage) return;
    this.state.provider = null;
    this.render();
    page.focusOnOpen();
  }

  /** @param {{ name: string, id?: string }} route */
  async openManagerPage(route) {
    const page = (this.managerPage ||= /** @type {any} */ (
      this.createPage("admin-site-manager-page")
    ));
    // The managers directory may already be reading GET people; reuse that read.
    page.loadManagers = (force) => this.loadSiteManagers(force);
    // A newer visit replaced the page, so this one must not render or focus.
    if (!(await page.open(route)) || page !== this.managerPage) return;
    this.state.provider = null;
    this.render();
    page.focusOnOpen();
  }

  /** Reattach every page's listeners, since render() replaces this element's HTML. */
  bind() {
    this.querySelector("#retry-compliance-draft")?.addEventListener(
      "click",
      () => {
        const draft = adminSession.complianceDraft;
        if (!draft) return;
        draft.phase = "returning";
        this.state.error = "";
        navigate(
          `/sites/${encodeURIComponent(draft.siteId)}?section=compliance`,
        );
      },
    );
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
          this.hasUnsavedSiteChanges() &&
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
      signOutAdmin();
    });
    this.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
  }

  /**
   * Render the current admin application state.
   * @returns {void}
   */
  render(loading = false) {
    this.state.hasToken = hasAdminSession();
    this.directorySearchDebounce?.cancel();
    const route = currentRoute();
    // A signed-out user never saw the new Program form, only a Program record.
    const pageElement =
      !loading &&
      this.programPage?.shows(route) &&
      (route.name !== "program-new" || this.state.hasToken)
        ? this.programPage
        : !loading && this.state.hasToken && this.routePage?.shows(route)
          ? this.routePage
          : !loading && this.sitePage?.shows(route)
            ? this.sitePage
            : !loading &&
                this.managerPage?.shows(route) &&
                (route.name !== "manager-new" || this.state.hasToken)
              ? this.managerPage
              : null;
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
        ${adminSession.complianceDraft?.phase === "recovery" ? `<button id="retry-compliance-draft" class="btn-secondary" type="button">${escapeHtml(t("admin.compliance.resumeDraft"))}</button>` : ""}
        ${
          this.state.hasToken && !loading && route.name === "system-status"
            ? this.state.capabilities.manageAdminUsers
              ? `<system-status-view view="${escapeHtml(route.id)}"></system-status-view>`
              : ""
            : ""
        }
        ${pageElement ? "<template data-page-slot></template>" : ""}
      ${!pageElement && route.name === "sites" ? discardChangesDialog() : ""}
      </main>
    `;
    this.bind();
    this.applyCapabilities();
    // Added last, so bind() and applyCapabilities() skip the page's own controls.
    if (pageElement)
      this.querySelector("template[data-page-slot]")?.replaceWith(pageElement);
    this.lastRenderedPath = window.location.pathname + window.location.search;
  }

  applyCapabilities() {
    const capabilities = this.state.capabilities;
    const editableSite = canEditSite(this.state);
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
mixActions(AdminApp, siteManagerActions);

customElements.define("admin-app", AdminApp);
