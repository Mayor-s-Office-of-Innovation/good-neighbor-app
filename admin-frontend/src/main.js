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
import { loadProviderManagerDirectory } from "./provider-manager-directory.js";
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
import { adminApi } from "./services/admin-api.js";
import { getAdminConfig } from "./config.js";
import { visibleRecords } from "./record-navigation.js";
import { siteManagerRoster } from "./site-managers.js";
import { escapeHtml, formatTimestamp } from "./dom.js";
import { currentRoute, navigate } from "./router.js";
import { canEditSite, canEditSiteManager } from "./site-permissions.js";
import {
  myProfileView,
  adminSettingsMenu,
  administratorView,
  newAdministratorView,
} from "./pages/admin-user/admin-user.templates.js";
import {
  discardChangesDialog,
  entityBreadcrumb,
} from "./pages/shared.templates.js";
import { siteManagerEditorView } from "./pages/site/manager.templates.js";
import {
  siteSectionNav,
  siteSectionView,
} from "./pages/site/record.templates.js";
import { directoryView } from "./pages/directory/directory.templates.js";
import { siteImportView } from "./pages/site/import.templates.js";
import { activeSiteSection } from "./pages/site/site-section.js";
import {
  newProviderView,
  providerView,
  providerManagerDetailView,
} from "./pages/provider/provider.templates.js";
import {
  newProgramView,
  programView,
} from "./pages/program/program.templates.js";
import { newSiteFlowView } from "./pages/site/new.templates.js";
import { syncDirtyForm, syncSiteDetailsForm } from "./form-state.js";
import { bindAdminUsers } from "./pages/admin-user/admin-user.bindings.js";
import {
  bindDirectoryFilters,
  bindDirectorySearch,
} from "./pages/directory/directory.bindings.js";
import { bindProvider } from "./pages/provider/provider.bindings.js";
import { bindProgram } from "./pages/program/program.bindings.js";
import { bindNewSiteFlow } from "./pages/site/new.bindings.js";
import { bindSiteManager } from "./pages/site/manager.bindings.js";
import {
  bindAddressLookup,
  bindSiteRecord,
} from "./pages/site/record.bindings.js";
import { bindSiteOversight } from "./pages/site/oversight.bindings.js";
import { bindSiteCompliance } from "./pages/site/compliance.bindings.js";
import { bindSiteImport } from "./pages/site/import.bindings.js";
import { bindSiteAccess } from "./pages/site/access.bindings.js";

import { addActions } from "./add-actions.js";
import { adminUserActions } from "./pages/admin-user/admin-user.actions.js";
import { siteManagerActions } from "./pages/site/manager.actions.js";
import { newSiteActions } from "./pages/site/new.actions.js";
import { siteImportActions } from "./pages/site/import.actions.js";
import { providerActions } from "./pages/provider/provider.actions.js";
import { programActions } from "./pages/program/program.actions.js";
import { siteOversightActions } from "./pages/site/oversight.actions.js";
import { siteRecordActions } from "./pages/site/record.actions.js";
import { siteComplianceActions } from "./pages/site/compliance.actions.js";
import { siteAccessActions } from "./pages/site/access.actions.js";
import { directoryActions } from "./pages/directory/directory.actions.js";
/**
 * @typedef {import("./admin-types.js").AdminState} AdminState
 */

class AdminApp extends HTMLElement {
  constructor() {
    super();
    /** @type {AdminState} */
    this.state = {
      providers: [],
      sites: [],
      programs: [],
      programManagers: [],
      adminUsers: [],
      adminUserStatusFilter: "all",
      adminUserMessage: "",
      adminUserDirectoryMode: "",
      siteManagers: [],
      siteManager: null,
      managerDirectoryLoaded: false,
      managerSearchFailed: false,
      oversightOptions: { departments: [], systemsOfCare: [] },
      program: null,
      provider: null,
      providerManagers: [],
      providerManagerGrants: [],
      providerManagerEnrollments: [],
      site: null,
      assignedUsers: [],
      assignedComplianceManagers: [],
      availableSiteUsers: [],
      newSiteUsers: [],
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
      profile: null,
      profileMessage: "",
      role: "",
      capabilities: {},
      importPreview: null,
      importResult: null,
      importBusy: false,
      importApplyKey: "",
      importHistory: [],
      importNotice: null,
      perimeterSaving: false,
      perimeterMessage: "",
      perimeterError: "",
      revocationMessage: "",
      physicalDeviceRevocationPreview: null,
      emergencyRevocationSites: [],
      emergencyRevocationPreview: null,
      suspensionTarget: null,
      managerMembershipRemovalTarget: null,
    };
  }

  /**
   * Initialize admin auth state and load provider data when signed in.
   * @returns {Promise<void>}
   */
  async connectedCallback() {
    this.state = {
      providers: [],
      sites: [],
      programs: [],
      programManagers: [],
      adminUsers: [],
      adminUserDirectoryMode: "",
      adminUserStatusFilter: "all",
      adminUserMessage: "",
      siteManagers: [],
      siteManager: null,
      managerDirectoryLoaded: false,
      managerSearchFailed: false,
      oversightOptions: { departments: [], systemsOfCare: [] },
      program: null,
      provider: null,
      providerManagers: [],
      providerManagerGrants: [],
      providerManagerEnrollments: [],
      site: null,
      assignedUsers: [],
      assignedComplianceManagers: [],
      availableSiteUsers: [],
      newSiteUsers: [],
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
      profile: null,
      profileMessage: "",
      role: "",
      capabilities: {},
      importPreview: null,
      importResult: null,
      importBusy: false,
      importApplyKey: "",
      importHistory: [],
      importNotice: null,
      revocationMessage: "",
      physicalDeviceRevocationPreview: null,
      emergencyRevocationSites: [],
      emergencyRevocationPreview: null,
      suspensionTarget: null,
      managerMembershipRemovalTarget: null,
      perimeterSaving: false,
      perimeterMessage: "",
      perimeterError: "",
    };
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

  beforeUnload = (event) => {
    if (!this.hasUnsavedSiteChanges()) return;
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
    if (this.hasUnsavedSiteChanges()) this.confirmSiteNavigation(destination);
    else navigate(destination);
  };

  routeChanged = () => {
    this.navigationGeneration = (this.navigationGeneration || 0) + 1;
    this.deviceRevocationController?.abort();
    this.directorySearchDebounce?.cancel();
    this.managerSearchCleanup?.();
    const destination = window.location.pathname + window.location.search;
    if (
      this.lastRenderedPath &&
      destination !== this.lastRenderedPath &&
      !(
        this.lastRenderedPath.split("?")[0] === "/sites" &&
        currentRoute().name === "sites"
      ) &&
      this.hasUnsavedSiteChanges()
    ) {
      window.history.pushState({}, "", this.lastRenderedPath);
      this.confirmSiteNavigation(destination);
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
    if (this.state.site311Batch?.drafts.size || this.state.site311Batch?.saving)
      return true;
    if (this.querySelector("#admin-user-form[data-saving='true']")) return true;
    const siteDetailsForm = this.querySelector("#site-details-form");
    const siteDetailsDirty =
      siteDetailsForm instanceof HTMLFormElement
        ? syncSiteDetailsForm(siteDetailsForm)
        : false;
    return (
      siteDetailsDirty ||
      Boolean(
        this.querySelector(
          "[data-dirty-form]:not(#site-details-form)[data-is-dirty='true']",
        ),
      )
    );
  }

  confirmSiteNavigation(destination) {
    // An invitation already in flight cannot be cancelled by leaving the page.
    if (this.querySelector("#admin-user-form[data-saving='true']")) return;
    if (this.state.site311Batch?.saving) return;
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
    if (form.id === "provider-manager-record-form") {
      await this.saveProviderManager(form);
      saved = true;
    }
    if (form.id === "provider-details-form") {
      await this.updateProvider(form);
      saved = true;
    }
    if (form.id === "site-manager-record-form")
      saved = await this.saveSiteManager(form);
    if (saved && destination) navigate(destination);
  }

  async bootstrap() {
    this.routeReadFailed = false;
    const session = await adminApi.getSession();
    this.state.role = session.role || "";
    this.state.capabilities = session.capabilities || {};
    if (this.state.role === "compliance-manager")
      this.state.profile = (await adminApi.getMyProfile()).profile;
    this.render(true);
    await this.openRoute();
  }

  async loadDirectory(openRoute = true, includeSites = true) {
    if (this.directoryPending) {
      await this.directoryPending;
      if (includeSites && !this.directoryLoaded)
        await this.loadDirectory(false, true);
      if (openRoute) await this.openRoute();
      return;
    }
    this.directoryPending = (async () => {
      const [providers, programs, oversightOptions, programManagers] =
        await Promise.all([
          adminApi.listProviders(includeSites),
          adminApi.listPrograms(),
          adminApi.listOversightOptions().catch((error) => {
            if ([401, 403].includes(error.status)) throw error;
            return null;
          }),
          adminApi.listCityProgramManagers(),
        ]);
      this.state.providers = providers.providers || [];
      this.state.programs = programs.programs || [];
      this.state.programManagers = programManagers.programManagers || [];
      this.programManagersStale = false;
      if (oversightOptions)
        this.state.oversightOptions = {
          departments: oversightOptions.departments || [],
          systemsOfCare: oversightOptions.systemsOfCare || [],
        };
      if (includeSites)
        this.state.sites = (providers.sites || [])
          .map(({ items }) => {
            const site = items.find((item) => item.sk === "#META");
            const manager = this.state.programManagers.find(
              (item) => item.userId === site?.oversight?.cityProgramManagerId,
            );
            if (manager)
              site.oversight = {
                ...site.oversight,
                cityProgramManager:
                  [manager.firstName, manager.lastName]
                    .filter(Boolean)
                    .join(" ") ||
                  manager.name ||
                  site.oversight.cityProgramManager,
              };
            return (
              site && {
                ...site,
                complianceManagerIds: items
                  .filter(
                    (item) =>
                      item.type === "siteComplianceManagerAssignment" &&
                      item.status === "active",
                  )
                  .map((item) => item.managerId),
                managerMemberships: siteManagerRoster(
                  items.filter((item) => item.type === "siteUserAssignment"),
                  items.filter((item) => item.type === "managerMembership"),
                ),
              }
            );
          })
          .filter(Boolean);
      // Keep usable records, but retry the missing optional lookup on navigation.
      this.catalogsLoaded = Boolean(oversightOptions);
      if (includeSites) this.directoryLoaded = true;
    })();
    try {
      await this.directoryPending;
    } finally {
      this.directoryPending = null;
    }
    if (openRoute) await this.openRoute();
  }

  async openRoute() {
    const route = currentRoute();
    const path = location.pathname + location.search;
    const needsSites = [
      "sites",
      "managers",
      "manager",
      "manager-new",
      "providers",
      "programs",
      "provider-managers",
      "profile",
    ].includes(route.name);
    if (
      ![
        "system-status",
        "administrators",
        "administrator-new",
        "provider-new",
        "site-import",
      ].includes(route.name) &&
      (!this.catalogsLoaded || (needsSites && !this.directoryLoaded))
    ) {
      await this.loadDirectory(false, needsSites);
      if (location.pathname + location.search !== path) return;
    }
    if (["administrator-new", "profile"].includes(route.name)) {
      this.state.oversightOptions = await adminApi.listOversightOptions();
      if (location.pathname + location.search !== path) return;
    }
    if (!["administrators", "administrator-new"].includes(route.name))
      this.useCachedAdminUsers = false;
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
      this.state.provider =
        this.state.program =
        this.state.site =
        this.state.siteManager =
          null;
      this.render();
      this.querySelector("#status-title")?.focus();
      return;
    }
    if (
      route.name === "provider-manager" ||
      route.name === "provider-managers"
    ) {
      if (!this.state.capabilities.manageProviderManagers)
        return navigate("/sites", { replace: true });
      if (route.name === "provider-manager")
        return this.openProvider(route.id, false);
      const directory = await loadProviderManagerDirectory(
        this.state.providers,
        adminApi,
      );
      if (location.pathname + location.search !== path) return;
      this.state.providerManagerDirectory = directory;
    }
    if (route.name === "profile") {
      const result = await adminApi.getMyProfile();
      if (location.pathname + location.search !== path) return;
      this.state.profile = result.profile;
      this.state.profileMessage = "";
      this.state.provider = null;
      this.state.program = null;
      this.state.site = null;
      this.state.siteManager = null;
      this.render();
      this.querySelector("#profile-title")?.focus();
      return;
    }
    if (route.name === "administrator-new") {
      if (!this.state.capabilities.manageAdminUsers)
        return navigate("/sites", { replace: true });
      this.useCachedAdminUsers = this.adminUsersLoaded === true;
      this.state.provider =
        this.state.program =
        this.state.site =
        this.state.siteManager =
          null;
      this.state.error = "";
      this.render();
      this.querySelector("#new-admin-user-title")?.focus();
      return;
    }
    if (route.name === "administrators") {
      if (!this.state.capabilities.manageAdminUsers)
        return navigate("/sites", { replace: true });
      if (!this.useCachedAdminUsers) {
        const result = await adminApi.listAdminUsers();
        if (location.pathname + location.search !== path) return;
        this.state.adminUsers = result.users || [];
        this.state.adminUserDirectoryMode = result.directoryMode || "cognito";
        this.adminUsersLoaded = true;
      }
      this.useCachedAdminUsers = false;
      this.state.provider = null;
      this.state.program = null;
      this.state.site = null;
      this.state.siteManager = null;
      this.render();
      this.querySelector("#administrators-title")?.focus();
      return;
    }
    if (route.name === "manager-new") {
      await this.loadSiteManagers();
      if (location.pathname + location.search !== path) return;
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      this.state.siteManager = null;
      this.state.provider = null;
      this.state.program = null;
      this.state.site = null;
      this.render();
      return;
    }
    if (route.name === "manager") return this.openSiteManager(route.id);
    if (
      route.name === "managers" &&
      !new URLSearchParams(location.search).get("q")?.trim()
    )
      await this.loadSiteManagers();
    if (location.pathname + location.search !== path) return;
    if (route.name === "site-new") return this.openNewSiteFlow();
    if (route.name === "site-import") return this.openSiteImport();
    if (route.name === "provider") return this.openProvider(route.id, false);
    if (route.name === "program") return this.openProgram(route.id, false);
    if (route.name === "site") return this.openSite(route.id, false, false);
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
    if (new URLSearchParams(location.search).get("q")?.trim())
      void this.loadSearchManagers();
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
    bindAdminUsers(this);
    bindAddressLookup(this);
    bindDirectorySearch(this);
    bindDirectoryFilters(this);
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
      this.state.providers = [];
      this.state.sites = [];
      this.state.provider = null;
      this.state.site = null;
      clearEnrollmentCodeView(this.state);
      signOutAdmin();
    });
    bindProvider(this);
    bindProgram(this);
    bindNewSiteFlow(this);
    bindSiteManager(this);
    bindSiteRecord(this);
    bindSiteOversight(this);
    this.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
    this.querySelectorAll(
      "#program-details-form, #admin-user-form, #site-oversight-form, #site-compliance-form, #site-perimeter-form, #site-manager-record-form, #provider-manager-record-form, #site-deliberate-311-form",
    ).forEach((form) => {
      const sync = () => syncDirtyForm(form);
      syncDirtyForm(form, true);
      form.addEventListener("input", sync);
      form.addEventListener("change", sync);
      form.addEventListener("reset", () => queueMicrotask(sync));
    });
    bindSiteCompliance(this);
    bindSiteImport(this);
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
    const { provider, program, site, siteManager } = loading
      ? {}
      : visibleRecords(this.state, route);
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
          this.state.hasToken &&
          !loading &&
          ![
            "provider",
            "program",
            "site",
            "manager",
            "provider-manager",
          ].includes(route.name)
            ? route.name === "system-status"
              ? this.state.capabilities.manageAdminUsers
                ? `<system-status-view view="${escapeHtml(route.id)}"></system-status-view>`
                : ""
              : route.name === "profile"
                ? myProfileView(this.state)
                : route.name === "administrator-new"
                  ? newAdministratorView(this.state)
                  : route.name === "administrators"
                    ? administratorView(this.state.adminUsers, this.state)
                    : route.name === "site-import"
                      ? siteImportView(this.state)
                      : route.name === "site-new"
                        ? newSiteFlowView(this.state)
                        : route.name === "provider-new"
                          ? newProviderView()
                          : route.name === "program-new"
                            ? newProgramView(this.state)
                            : route.name === "manager-new"
                              ? siteManagerEditorView(this.state, null)
                              : directoryView(this.state, route)
            : ""
        }
        ${provider ? providerView(this.state) : ""}
        ${!loading && route.name === "provider-manager" && this.state.provider?.providerId === route.id ? providerManagerDetailView(this.state, route.membershipId) : ""}
        ${program ? programView(program, this.state.capabilities.createEntities === true) : ""}
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
      ${!site && !program && route.name === "sites" ? discardChangesDialog() : ""}
      </main>
    `;
    this.bind();
    this.applyCapabilities();
    syncEnrollmentRequests(this);
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
addActions(AdminApp.prototype, [
  adminUserActions,
  siteManagerActions,
  newSiteActions,
  siteImportActions,
  providerActions,
  programActions,
  siteOversightActions,
  siteRecordActions,
  siteComplianceActions,
  siteAccessActions,
  directoryActions,
]);

customElements.define("admin-app", AdminApp);
