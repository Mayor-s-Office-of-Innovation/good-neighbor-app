import { startErrorPresentation } from "../../frontend/src/components/error-notice.js";
import { mountConnectionBanner } from "../../frontend/src/components/connection-banner.js";
startErrorPresentation();
mountConnectionBanner();
import { adminErrorMessage } from "./admin-error-messages.js";
import { peopleDirectory } from "./people-directory.js";
import {
  providerManagerPath,
  loadProviderManagerDirectory,
  revokeProviderDevices,
  removeProviderManagerAccess,
} from "./provider-manager-directory.js";
import { localRoleEnabled, getLocalRole, setLocalRole } from "./local-role.js";
import { actionFeedback, notifyAdmin } from "./action-feedback.js";
import "../../frontend/src/components/app-toasts.js";
import {
  captureComplianceDraft,
  complianceDraftAfterNavigation,
  restoreComplianceDraft,
} from "./compliance-profile-draft.js";
import {
  siteProviderPrograms,
  bindSiteProgramCreation,
} from "./site-program.js";
import { phoneExtensionField, bindPhoneExtensions } from "./phone-extension.js";
import { withSaveFeedback, upsertRecord } from "./save-feedback.js";
import { bindNewProgramStaff } from "./new-program-staff.js";
import { createAndAssignManager } from "./pending-manager.js";
import { letterEmailProgress, profilePhoneUpdate } from "./admin-save-state.js";
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
import { mapWithConcurrency } from "./concurrency.js";
import { visibleRecords } from "./record-navigation.js";
import { siteManagerRoster } from "./site-managers.js";
import { debounce } from "./debounce.js";
import { loadProgramStaff, primaryProgramStaffId } from "./program-staff.js";
import {
  defaultProgramManagerFilter,
  matchesProgramManager,
} from "./program-manager-filter.js";
import {
  createDirectoryLoader,
  loadManagerDirectory,
} from "./manager-directory.js";
import { asForm, dataAttr, escapeHtml, formatTimestamp } from "./dom.js";
import { currentRoute, navigate } from "./router.js";
import { selectedLeadProgram } from "./site-assignment.js";
import {
  attachCreatedEnrollmentUrl,
  copyEnrollmentUrl,
} from "./enrollment-links.js";

/**
 * @typedef {ReturnType<typeof getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, complianceManagerIds?: string[], siteName?: string, name?: string, siteType?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, primaryContact?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number | boolean>, perimeter?: string, perimeterUpdatedAt?: string, perimeterUpdatedBy?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, letterState?: string, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, leadProgramId?: string, programName?: string, primaryContactUserId?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {object} AdminState
 * @property {AdminProvider[]} providers
 * @property {AdminSite[]} sites
 * @property {any[]} programs
 * @property {any[]} programManagers
 * @property {any[]} adminUsers
 * @property {string} adminUserStatusFilter
 * @property {string} adminUserMessage
 * @property {string} adminUserDirectoryMode
 * @property {any[]} [people]
 * @property {any[]} siteManagers
 * @property {any | null} siteManager
 * @property {boolean} managerSearchFailed
 * @property {boolean} managerDirectoryLoaded
 * @property {{ departments: any[], systemsOfCare: any[] }} oversightOptions
 * @property {any | null} program
 * @property {AdminProvider | null} provider
 * @property {any[]} [providerManagerDirectory]
 * @property {any[]} providerManagers
 * @property {Record<string, string>} [providerManagerGrantErrors]
 * @property {any[]} providerManagerGrants
 * @property {any[]} providerManagerEnrollments
 * @property {AdminSite | null} site
 * @property {any[]} assignedUsers
 * @property {any[]} assignedComplianceManagers
 * @property {any[]} availableSiteUsers
 * @property {any[]} newSiteUsers
 * @property {boolean} letterEmailUncertain
 * @property {string | null} [expandedLettersSiteId]
 * @property {string | null} [expandedTermsSiteId]
 * @property {any[]} letterEmailHistory
 * @property {any[]} siteTerms
 * @property {any[]} managerMemberships
 * @property {any[]} managerGrants
 * @property {AdminDevice[]} devices
 * @property {AdminIssuedCode | null} issuedCode
 * @property {string} siteSaveMessage
 * @property {string} siteSaveError
 * @property {boolean} siteSaving
 * @property {string} error
 * @property {boolean} hasToken
 * @property {AdminConfig} authConfig
 * @property {boolean} authBusy
 * @property {ReturnType<typeof captureComplianceDraft> | null} complianceProfileDraft
 * @property {any | null} profile
 * @property {string} profileMessage
 * @property {string} role
 * @property {boolean} [siteCanEdit]
 * @property {Record<string, boolean>} capabilities
 * @property {any | null} importPreview
 * @property {any | null} importResult
 * @property {boolean} importBusy
 * @property {string} importApplyKey
 * @property {any[]} importHistory
 * @property {{ title: string, message: string } | null} importNotice
 * @property {boolean} perimeterSaving
 * @property {string} perimeterMessage
 * @property {string} perimeterError
 * @property {string} revocationMessage
 * @property {any | null} physicalDeviceRevocationPreview
 * @property {any[]} emergencyRevocationSites
 * @property {any | null} emergencyRevocationPreview
 * @property {any | null} suspensionTarget
 * @property {any | null} managerMembershipRemovalTarget
 */

const DIRECTORY_REQUEST_CONCURRENCY = 3;

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
    window.removeEventListener("popstate", this.routeChanged);
    window.removeEventListener("beforeunload", this.beforeUnload);
  }

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
    this.directorySearchDebounce?.cancel();
    const destination = window.location.pathname + window.location.search;
    if (
      this.lastRenderedPath &&
      destination !== this.lastRenderedPath &&
      this.hasUnsavedSiteChanges()
    ) {
      window.history.pushState({}, "", this.lastRenderedPath);
      this.confirmSiteNavigation(destination);
      return;
    }
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
    this.pendingSiteDestination = destination;
    this.querySelector("#site-unsaved-dialog")?.showModal();
  }

  async saveAndLeaveSite() {
    const form = this.querySelector("[data-dirty-form][data-is-dirty='true']");
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const destination = this.pendingSiteDestination;
    let saved = false;
    if (form.id === "site-details-form") saved = await this.updateSite(form);
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

  async inviteAdministrator(form) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    const origin = location.pathname + location.search;
    try {
      const data = new FormData(form);
      const values = Object.fromEntries(
        [
          "firstName",
          "lastName",
          "email",
          "phone",
          "phoneExtension",
          "departmentId",
          "role",
        ].map((name) => [name, String(data.get(name) || "").trim()]),
      );
      const result = await adminApi.inviteAdminUser(values);
      this.programManagersStale = true;
      this.state.adminUsers = upsertRecord(
        this.state.adminUsers,
        result.user,
        "username",
      );
      this.state.adminUserMessage = "";
      this.state.adminUserStatusFilter = "all";
      syncDirtyForm(form, true);
      delete form.dataset.saving;
      feedback.success(
        result.invitationStatus === "active"
          ? "admin.toast.accountActive"
          : "admin.toast.invitationSent",
      );
      if (location.pathname + location.search !== origin) return;
      navigate("/administrators");
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
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

  async loadSearchManagers() {
    if (this.state.managerDirectoryLoaded || this.managerSearchPending) return;
    this.managerSearchPending = true;
    this.state.managerSearchFailed = false;
    try {
      await this.loadSiteManagers();
    } catch {
      this.state.managerSearchFailed = true;
    } finally {
      this.managerSearchPending = false;
    }
    const input = this.querySelector("#directory-search-input");
    if (
      !input ||
      (!new URLSearchParams(location.search).get("q")?.trim() &&
        currentRoute().name !== "managers")
    )
      return;
    this.renderDirectoryResults();
  }

  async loadSiteManagers(force = false) {
    this.managerDirectoryLoader ||= createDirectoryLoader(() =>
      this.fetchSiteManagers(),
    );
    if (
      this.state.managerDirectoryLoaded &&
      !force &&
      !this.managerDirectoryLoader.pending
    )
      return;
    return this.managerDirectoryLoader.load(
      force ||
        (this.managerDirectoryLoader.pending &&
          this.managerFetchVersion !== (this.managerDirectoryVersion || 0)),
    );
  }

  async fetchSiteManagers() {
    const version = (this.managerFetchVersion =
      this.managerDirectoryVersion || 0);
    const activePrograms = this.state.programs.filter(
      (program) => program.status !== "inactive",
    );
    const activeSites = this.state.sites.filter(
      (site) => site.status !== "inactive",
    );
    const { programDetails, siteMemberships } = await loadManagerDirectory(
      activePrograms,
      activeSites,
      adminApi,
      DIRECTORY_REQUEST_CONCURRENCY,
    );
    if (version !== (this.managerDirectoryVersion || 0)) return;
    const memberships = siteMemberships.flatMap(({ site, memberships }) =>
      (memberships || []).map((membership) => ({
        ...membership,
        siteId: site.siteId,
        siteName: site.name,
        leadProgramId: site.leadProgramId,
      })),
    );
    const legacyManagers = programDetails
      .flatMap((detail) =>
        (detail.users || []).flatMap((user) => {
          if (user.status === "inactive") return [];
          const assignedSites = memberships.filter(
            (membership) =>
              membership.userId === user.userId ||
              (!membership.userId &&
                membership.leadProgramId === detail.program.programId &&
                String(membership.email || "").toLowerCase() ===
                  String(user.email || "").toLowerCase()),
          );
          if (user.siteManager !== true && !assignedSites.length) return [];
          return [
            {
              ...user,
              programId: detail.program.programId,
              programName: detail.program.name,
              providerId: detail.program.providerId,
              assignedSites,
            },
          ];
        }),
      )
      .sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(
          `${b.firstName} ${b.lastName}`,
        ),
      );
    const { people = [] } = await adminApi.listPeople();
    if (version !== (this.managerDirectoryVersion || 0)) return;
    this.state.people = people;
    this.state.siteManagers = peopleDirectory(
      people,
      memberships,
      this.state.programs,
      this.state.providers,
      legacyManagers,
    );
    this.state.managerDirectoryLoaded = true;
    this.state.managerSearchFailed = false;
  }

  async openSiteManager(userId) {
    const path = location.pathname + location.search;
    await this.loadSiteManagers();
    if (location.pathname + location.search !== path) return;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.siteManager =
      this.state.siteManagers.find(
        (manager) =>
          manager.userId === userId || manager.legacyUserIds?.includes(userId),
      ) || null;
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    if (!this.state.siteManager) this.state.error = "Site manager not found.";
    else if (this.state.siteManager.userId !== userId)
      window.history.replaceState(
        {},
        "",
        `/managers/${encodeURIComponent(this.state.siteManager.userId)}${location.search}`,
      );
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openNewSiteFlow() {
    const path = location.pathname + location.search;
    const programId = new URLSearchParams(window.location.search).get(
      "programId",
    );
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.state.newSiteUsers = [];
    if (programId) {
      const result = await adminApi.getProgram(programId);
      if (location.pathname + location.search !== path) return;
      this.state.newSiteUsers = (result.users || []).filter(
        (user) => user.status !== "inactive",
      );
    }
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openSiteImport() {
    let path = location.pathname + location.search;
    if (this.state.importBusy) {
      this.render();
      return;
    }
    const importId = new URLSearchParams(window.location.search).get(
      "importId",
    );
    if (!importId) {
      this.state.importPreview = null;
      this.state.importResult = null;
      this.state.importApplyKey = "";
    }
    if (importId && this.state.importPreview?.importId !== importId) {
      const result = await adminApi.getSiteImport(importId);
      if (location.pathname + location.search !== path) return;
      if (result.import.status === "complete") {
        this.state.importPreview = null;
        this.state.importResult = null;
        this.state.importApplyKey = "";
        window.history.replaceState({}, "", "/sites/import");
        path = location.pathname + location.search;
      } else {
        this.state.importPreview = {
          importId,
          previewVersion: result.import.previewVersion,
          previewExpiresAt: result.import.previewExpiresAt,
          counts: result.import.counts,
          rows: result.rows,
        };
        this.state.importResult = null;
        this.state.importApplyKey =
          sessionStorage.getItem(`site-import-key:${importId}`) ||
          result.import.idempotencyKey ||
          crypto.randomUUID();
        sessionStorage.setItem(
          `site-import-key:${importId}`,
          this.state.importApplyKey,
        );
      }
    }
    const history = await adminApi
      .listSiteImports()
      .catch(() => ({ imports: [] }));
    if (location.pathname + location.search !== path) return;
    this.state.importHistory = history.imports || [];
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  /**
   * Load active providers visible to central admins.
   * @returns {Promise<void>}
   */
  async loadProviders() {
    try {
      const data = await adminApi.listProviders();
      this.state.providers = data.providers || [];
      this.state.error = "";
    } catch (err) {
      this.state.error = err.message;
    }
    this.render();
  }

  /**
   * Create a provider from the add-provider form.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async createProvider(form) {
    const feedback = actionFeedback("admin.toast.providerCreated");
    try {
      const origin = location.pathname + location.search;
      const name = new FormData(form).get("provider-name");
      if (!name) return;
      const result = await adminApi.createProvider(String(name));
      feedback.success();
      this.state.providers = upsertRecord(
        this.state.providers,
        result.provider,
        "providerId",
      );
      if (location.pathname + location.search !== origin) return;
      const params = new URLSearchParams(window.location.search);
      if (params.get("returnTo") === "site-new") {
        navigate(
          `/sites/new?providerId=${encodeURIComponent(result.provider.providerId)}`,
        );
        return;
      }
      navigate(`/providers/${encodeURIComponent(result.provider.providerId)}`);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async updateProvider(form) {
    const feedback = actionFeedback("admin.toast.providerSaved");
    try {
      if (!this.state.provider) return;
      const name = formValue(new FormData(form), "provider-name");
      const result = await adminApi.updateProvider(
        this.state.provider.providerId,
        { name },
      );
      feedback.success();
      this.state.provider = {
        ...this.state.provider,
        ...result.provider,
      };
      this.state.providers = this.state.providers.map((provider) =>
        provider.providerId === result.provider.providerId
          ? { ...provider, ...result.provider }
          : provider,
      );
      this.state.siteSaveMessage = "";
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async saveProviderManager(form) {
    const feedback = actionFeedback("admin.toast.providerManagerSaved");
    try {
      if (!this.state.provider) return;
      const data = new FormData(form);
      const values = {
        ...(form.dataset.personId ? { personId: form.dataset.personId } : {}),
        firstName: formValue(data, "provider-manager-first-name"),
        lastName: formValue(data, "provider-manager-last-name"),
        email: formValue(data, "provider-manager-email"),
        phone: formValue(data, "provider-manager-phone"),
        phoneExtension: formValue(data, "provider-manager-extension"),
      };
      const membershipId = formValue(data, "provider-manager-membership-id");
      const providerId = this.state.provider.providerId;
      const result = membershipId
        ? await adminApi.updateProviderManager(providerId, membershipId, values)
        : await adminApi.createProviderManager(providerId, values);
      feedback.success();
      if (this.state.provider?.providerId !== providerId) return;
      this.state.providerManagers = upsertRecord(
        this.state.providerManagers,
        {
          ...this.state.providerManagers.find(
            (manager) => manager.membershipId === membershipId,
          ),
          ...result.manager,
        },
        "membershipId",
      );
      this.state.siteSaveMessage = "";
      this.render();
      if (membershipId) {
        [...this.querySelectorAll("[data-edit-provider-manager]")]
          .find(
            (button) =>
              dataAttr(button, "data-edit-provider-manager") === membershipId,
          )
          ?.focus();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async setProviderManagerActive(membershipId, active) {
    const feedback = actionFeedback("admin.toast.accessUpdated");
    try {
      if (!this.state.provider) return;
      if (active) {
        await adminApi.reinstateProviderManager(
          this.state.provider.providerId,
          membershipId,
        );
      } else {
        await removeProviderManagerAccess(
          adminApi,
          this.state.provider.providerId,
          membershipId,
        );
      }
      feedback.success();
      if (
        (await this.refreshProviderAccess(this.state.provider.providerId)) ===
        false
      )
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async issueProviderManagerGrant(membershipId, deliveryMode = "link") {
    const feedback = actionFeedback("admin.enrollment.emailed");
    const providerId = this.state.provider?.providerId;
    try {
      if (!this.state.provider) return;
      const created = await adminApi.createProviderManagerGrant(
        this.state.provider.providerId,
        membershipId,
        deliveryMode,
      );
      feedback.success(
        created.grant?.deliveryStatus === "accepted"
          ? deliveryMode === "code"
            ? "admin.enrollment.codeEmailed"
            : "admin.enrollment.emailed"
          : "admin.toast.enrollmentEmailFailed",
        created.grant?.deliveryStatus === "accepted" ? "success" : "error",
      );
      if (
        (await this.refreshProviderAccess(
          this.state.provider.providerId,
          false,
        )) === false
      )
        return;
      this.state.providerManagerGrants = attachCreatedEnrollmentUrl(
        this.state.providerManagerGrants,
        created,
      );
      this.render();
    } catch (error) {
      if (error.message === "provider_manager_grant_already_active") {
        error.message = t("admin.enrollment.alreadyActive");
        feedback.failure(error);
        if (this.state.provider?.providerId === providerId) {
          this.state.providerManagerGrantErrors = {
            ...this.state.providerManagerGrantErrors,
            [membershipId]: error.message,
          };
          this.render();
        }
        return;
      } else if (
        ["provider_manager_grant_conflict", "manager_grant_conflict"].includes(
          error.message,
        )
      ) {
        error.message = t("admin.enrollment.conflict");
      }
      feedback.failure(error);
      throw error;
    }
  }

  async cancelProviderManagerGrant(grantId) {
    const feedback = actionFeedback("admin.toast.linkCancelled");
    try {
      if (!this.state.provider) return;
      await adminApi.cancelProviderManagerGrant(
        this.state.provider.providerId,
        grantId,
      );
      feedback.success();
      if (
        (await this.refreshProviderAccess(this.state.provider.providerId)) ===
        false
      )
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async revokeProviderManagerEnrollment(enrollmentId) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.provider) return;
      await adminApi.revokeProviderManagerEnrollment(
        this.state.provider.providerId,
        enrollmentId,
      );
      feedback.success();
      if (
        (await this.refreshProviderAccess(this.state.provider.providerId)) ===
        false
      )
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async addProgramToProvider(form) {
    const feedback = actionFeedback("admin.toast.programAssigned");
    try {
      if (!this.state.provider) return;
      const providerId = this.state.provider.providerId;
      const programId = formValue(new FormData(form), "program-id");
      if (!programId) return;
      await adminApi.assignProgramToProvider(providerId, programId);
      feedback.success();
      this.state.programs = (await adminApi.listPrograms()).programs || [];
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /**
   * Refresh access state after a provider access mutation.
   * @param {string} providerId
   * @param {boolean} [renderNow]
   */
  async refreshProviderAccess(providerId, renderNow = true) {
    const [managers, grants] = await Promise.all([
      adminApi.listProviderManagers(providerId),
      adminApi.listProviderManagerGrants(providerId),
    ]);
    if (
      this.state.provider?.providerId !== providerId ||
      !["provider", "provider-manager"].includes(currentRoute().name)
    )
      return false;
    this.state.providerManagers = managers.managers || [];
    this.state.providerManagerEnrollments = managers.enrollments || [];
    this.state.providerManagerGrants = grants.grants || [];
    if (renderNow) this.render();
    return true;
  }

  async refreshSiteAccess(siteId, renderNow = true) {
    const [memberships, grants, devices] = await Promise.all([
      adminApi.listManagerMemberships(siteId),
      adminApi.listManagerGrants(siteId),
      adminApi.listDevices(siteId),
    ]);
    if (this.state.site?.siteId !== siteId || currentRoute().name !== "site")
      return false;
    this.state.managerMemberships = siteManagerRoster(
      this.state.assignedUsers,
      memberships.memberships || [],
      this.state.availableSiteUsers,
    );
    this.state.managerGrants = grants.grants || [];
    this.state.devices = devices.devices || [];
    this.siteSectionLoads?.clear();
    if (renderNow) this.render();
    return true;
  }

  async refreshProgramStaff(programId) {
    const result = await adminApi.getProgram(programId);
    if (
      this.state.program?.programId !== programId ||
      currentRoute().name !== "program"
    )
      return;
    const previous = this.state.program.users || [];
    this.state.program = {
      ...result.program,
      sites: result.sites,
      users: (result.users || []).map((user) => ({
        ...previous.find((p) => p.userId === user.userId),
        ...user,
      })),
    };
    this.render();
  }

  async openProvider(providerId, updateUrl = true) {
    if (updateUrl)
      return navigate(`/providers/${encodeURIComponent(providerId)}`);
    const path = location.pathname + location.search;
    const canManage = this.state.capabilities.manageProviderManagers === true;
    const [data, managers, grants, people] = await Promise.all([
      adminApi.getProvider(providerId),
      canManage
        ? adminApi.listProviderManagers(providerId)
        : Promise.resolve({ managers: [] }),
      canManage
        ? adminApi.listProviderManagerGrants(providerId)
        : Promise.resolve({ grants: [] }),
      canManage ? adminApi.listPeople() : null,
    ]);
    if (location.pathname + location.search !== path) return;
    if (people) this.state.people = people.people || [];
    this.state.provider = data.provider;
    this.state.providerManagers = managers.managers || [];
    this.state.providerManagerEnrollments = managers.enrollments || [];
    this.state.providerManagerGrants = grants.grants || [];
    this.state.providerManagerGrantErrors = {};
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.provider.sites = data.sites || [];
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openProgram(programId, updateUrl = true) {
    if (updateUrl)
      return navigate(`/programs/${encodeURIComponent(programId)}`);
    const path = location.pathname + location.search;
    const data = await adminApi.getProgram(programId);
    const program = {
      ...data.program,
      sites: data.sites,
      users: await loadProgramStaff(
        { ...data.program, sites: data.sites, users: data.users },
        adminApi,
        DIRECTORY_REQUEST_CONCURRENCY,
      ),
    };
    if (location.pathname + location.search !== path) return;
    this.state.program = program;
    this.state.provider = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => {
      if (
        new URLSearchParams(location.search).get("addStaff") === "1" &&
        this.state.capabilities.createEntities === true
      ) {
        this.querySelector("#add-program-staff-dialog")?.showModal();
        const params = new URLSearchParams(location.search);
        params.delete("addStaff");
        history.replaceState(
          {},
          "",
          `${location.pathname}${params.size ? `?${params}` : ""}`,
        );
      } else this.querySelector("h1")?.focus();
    });
  }

  async saveProgramStaff(form) {
    const feedback = actionFeedback("admin.toast.staffSaved");
    try {
      if (form.dataset.saving) return;
      const userId = form.dataset.programStaffEditForm;
      const user = this.state.program.users.find(
        (item) => item.userId === userId,
      );
      if (!user) return;
      form.dataset.saving = "true";
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      const data = new FormData(form);
      try {
        await adminApi.updateProgramUser(this.state.program.programId, userId, {
          firstName: formValue(data, "staff-first-name"),
          lastName: formValue(data, "staff-last-name"),
          phone: formValue(data, "staff-phone"),
          phoneExtension: formValue(data, "staff-extension"),
          email:
            this.state.capabilities.createEntities === true
              ? formValue(data, "staff-email")
              : user.email,
          siteManager: user.siteManager === true,
          ...(this.state.capabilities.createEntities === true
            ? { isPrimaryContact: data.has("staff-primary-contact") }
            : {}),
        });
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(form, t("admin.programs.staffEditError"));
        delete form.dataset.saving;
        button.disabled = false;
        return;
      }
      feedback.success();
      form.closest("dialog")?.close();
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      try {
        await this.refreshProgramStaff(this.state.program.programId);
        this.querySelector(
          `[data-edit-program-staff="${CSS.escape(userId)}"]`,
        )?.focus();
      } catch (error) {
        feedback.failure(error);
        this.state.error = error.message;
        this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async addProgramStaff(form) {
    const feedback = actionFeedback("admin.toast.staffAdded");
    try {
      if (form.dataset.saving) return;
      form.dataset.saving = "true";
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      const data = new FormData(form);
      const programId = this.state.program.programId;
      try {
        await adminApi.createProgramUser(programId, {
          firstName: formValue(data, "staff-first-name"),
          lastName: formValue(data, "staff-last-name"),
          phone: formValue(data, "staff-phone"),
          phoneExtension: formValue(data, "staff-extension"),
          email: formValue(data, "staff-email"),
          siteManager: false,
        });
        feedback.success();
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(
          form,
          adminErrorMessage(error, t, t("admin.programs.staffSaveError")),
        );
        delete form.dataset.saving;
        if (submit) submit.disabled = false;
        return;
      }
      this.querySelector("#add-program-staff-dialog")?.close();
      await this.refreshProgramStaff(programId);
      this.querySelector("#add-program-staff")?.focus();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async createProgram(form) {
    const feedback = actionFeedback("admin.toast.programCreated");
    try {
      const origin = location.pathname + location.search;
      const data = new FormData(form);
      const selection = form.querySelector('[name="program-staff"]');
      const rawStaff = String(data.get("program-staff") || "");
      if (selection?.disabled || !rawStaff || rawStaff === "__create__")
        throw new Error(t("admin.programs.chooseStaff"));
      const staff = JSON.parse(decodeURIComponent(rawStaff));
      if (!staff || (!staff.existingStaff && !staff.firstStaff))
        throw new Error(t("admin.programs.chooseStaff"));
      const result = await adminApi.createProgram({
        name: String(data.get("program-name") || ""),
        providerId: String(data.get("program-provider") || ""),
        ...staff,
      });
      feedback.success();
      this.state.programs = upsertRecord(
        this.state.programs,
        result.program,
        "programId",
      );
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      if (location.pathname + location.search !== origin) return;
      const returnTo = new URLSearchParams(window.location.search).get(
        "returnTo",
      );
      if (returnTo === "site-new") {
        navigate(
          `/sites/new?providerId=${encodeURIComponent(result.program.providerId)}&programId=${encodeURIComponent(result.program.programId)}`,
        );
        return;
      }
      if (returnTo === "provider") {
        navigate(`/providers/${encodeURIComponent(result.program.providerId)}`);
        return;
      }
      navigate(`/programs/${encodeURIComponent(result.program.programId)}`);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {HTMLFormElement} form */

  async createCityProgramManager(form) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    try {
      const data = new FormData(form);
      const email = formValue(data, "manager-email").toLowerCase();
      const departmentId = controlValue(form, "manager-department");
      const department = this.state.oversightOptions.departments.find(
        (item) => (item.departmentId || item.name) === departmentId,
      );
      const invitation = await adminApi.inviteAdminUser({
        firstName: formValue(data, "manager-first-name"),
        lastName: formValue(data, "manager-last-name"),
        email,
        phone: formValue(data, "manager-phone"),
        phoneExtension: formValue(data, "manager-extension"),
        departmentId,
        departmentName: department?.name || "",
        role: "compliance-manager",
      });
      feedback.success(
        invitation.invitationStatus === "active"
          ? "admin.toast.accountActive"
          : "admin.toast.invitationSent",
      );
      const result = await adminApi.listCityProgramManagers();
      this.state.programManagers = result.programManagers || [];
      const manager = this.state.programManagers.find(
        (item) => String(item.email || "").toLowerCase() === email,
      );
      if (!manager) throw new Error("program_manager_directory_sync_failed");
      this.addComplianceManagerAssignment(manager);
      this.state.siteSaveMessage =
        invitation.invitationStatus === "active"
          ? "Existing account selected. Save changes to assign this manager."
          : invitation.invitationStatus === "resent"
            ? "Invitation re-sent. Save changes to assign this manager."
            : "Invitation sent. Save changes to assign this manager.";
      form.closest("dialog")?.close();
      form.reset();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {any} manager */
  addComplianceManagerAssignment(manager) {
    const list = this.querySelector("[data-compliance-manager-list]");
    if (!list) return;
    const managerId = String(manager.userId || manager.managerId || "");
    if (
      !managerId ||
      list.querySelector(`[data-manager-id="${CSS.escape(managerId)}"]`)
    )
      return;
    if (list.querySelectorAll("li[data-manager-id]").length >= 2) {
      throw new Error("A site can have no more than two Program managers.");
    }
    list.insertAdjacentHTML(
      "beforeend",
      complianceManagerAssignmentRow(
        manager,
        this.state.capabilities.createEntities === true,
      ),
    );
    this.bindComplianceManagerAssignmentControls();
    const form = list.closest("form");
    if (form instanceof HTMLFormElement) syncDirtyForm(form);
    this.updateComplianceManagerCount();
  }

  bindComplianceManagerAssignmentControls() {
    this.querySelectorAll("[data-remove-compliance-manager]").forEach(
      (button) => {
        if (button.dataset.bound === "true") return;
        button.dataset.bound = "true";
        button.addEventListener("click", () => {
          button.closest("li[data-manager-id]")?.remove();
          const form = this.querySelector("#site-oversight-form");
          if (form instanceof HTMLFormElement) syncDirtyForm(form);
          this.updateComplianceManagerCount();
        });
      },
    );
    this.querySelectorAll("[data-invite-compliance-manager]").forEach(
      (button) => {
        if (button.dataset.bound === "true") return;
        button.dataset.bound = "true";
        button.addEventListener("click", () => {
          this.inviteExistingComplianceManager(button);
        });
      },
    );
  }

  /** @param {HTMLButtonElement} button */
  async inviteExistingComplianceManager(button) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    try {
      const manager = this.state.programManagers.find(
        (item) => item.userId === button.dataset.managerId,
      );
      if (!manager) return;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Sending…";
      const row = button.closest("[data-manager-id]");
      row?.querySelector("[data-invite-status]")?.remove();
      try {
        const invitation = await adminApi.inviteAdminUser({
          firstName: manager.firstName,
          lastName: manager.lastName,
          email: manager.email,
          phone: manager.phone,
          phoneExtension: manager.phoneExtension,
          departmentId: manager.departmentId,
          departmentName: manager.departmentName,
          role: "compliance-manager",
        });
        feedback.success(
          invitation.invitationStatus === "active"
            ? "admin.toast.accountActive"
            : "admin.toast.invitationSent",
        );
        manager.accountStatus = invitation.user.lifecycleStatus;
        row?.querySelector(".compliance-manager-assignment__warning")?.remove();
        const status = document.createElement("span");
        status.className = "muted";
        status.dataset.inviteStatus = "";
        status.setAttribute("role", "status");
        status.textContent = programManagerAccountLabel(manager.accountStatus);
        button.replaceWith(status);
      } catch (error) {
        feedback.failure(error);
        button.disabled = false;
        button.textContent = originalLabel;
        const status = document.createElement("span");
        status.className = "error";
        status.dataset.inviteStatus = "";
        status.setAttribute("role", "alert");
        status.textContent = siteSaveErrorMessage(error);
        button.after(status);
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  updateComplianceManagerCount() {
    const count = this.querySelectorAll(
      "[data-compliance-manager-list] > li[data-manager-id]",
    ).length;
    const addButton = this.querySelector("#add-compliance-manager");
    if (addButton) addButton.disabled = count >= 2;
    const limit = this.querySelector("[data-compliance-manager-limit]");
    if (limit) limit.hidden = count < 2;
    const empty = this.querySelector("[data-no-compliance-managers]");
    if (empty) empty.hidden = count > 0;
  }

  async createOversightOption(form) {
    const feedback = actionFeedback("admin.toast.optionCreated");
    try {
      const data = new FormData(form);
      const type = formValue(data, "option-type");
      const result = await adminApi.createOversightOption({
        type,
        name: formValue(data, "option-name"),
      });
      feedback.success();
      const key = type === "department" ? "departments" : "systemsOfCare";
      this.state.oversightOptions[key] = [
        ...this.state.oversightOptions[key],
        result.option,
      ].sort((a, b) => a.name.localeCompare(b.name));
      const target =
        form.dataset.targetSelect ||
        (type === "department"
          ? "managing-city-department"
          : "managing-system-of-care");
      await this.finishOversightOptionFlow(
        target,
        target === "manager-department"
          ? result.option.departmentId || result.option.name
          : result.option.name,
        form,
        result.option.name,
      );
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async finishOversightOptionFlow(selectName, value, form, label = value) {
    const select = this.querySelector(`wa-select[name='${selectName}']`);
    if (select) {
      const option = document.createElement("wa-option");
      option.value = value;
      option.textContent = label;
      select.querySelector(`[value='${CSS.escape(value)}']`)?.remove();
      const addOption = select.querySelector("[data-add-option]");
      if (addOption) addOption.before(option);
      else select.append(option);
      // wa-select caches its options until slotchange has been processed.
      // Yield a task so the new option is recognized before assigning value.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!select.isConnected) return;
      setSelectValue(select, value);
      await select.updateComplete;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    form.closest("dialog")?.close();
    form.reset();
  }

  async createSiteFromFlow(form) {
    const feedback = actionFeedback("admin.toast.siteCreated");
    const origin = location.pathname + location.search;
    try {
      const data = new FormData(form);
      const providerId = formValue(data, "provider-id");
      const programId = formValue(data, "lead-program-id");
      const addressParts = addressPartsFromForm(data);
      const address = formatAddressParts(addressParts);
      const expectedManagerId = formValue(data, "site-manager-user-id");
      // Navigation can replace newSiteUsers while the save is pending.
      const staff = this.state.newSiteUsers.find(
        (user) => user.userId === expectedManagerId,
      );
      const result = await adminApi.createSite(providerId, {
        name: formValue(data, "site-name"),
        address,
        addressParts,
        leadProgramId: programId,
        publicContact: {
          email: formValue(data, "public-contact-email"),
          phone: formValue(data, "public-contact-phone"),
          phoneExtension: formValue(data, "public-contact-extension"),
        },
        primaryContactUserId: formValue(data, "site-manager-user-id"),
        siteType: controlValue(form, "site-type"),
      });
      feedback.changed();
      const siteId = result.site.siteId;
      let savedSite = result.site;
      if (
        !result.site.addressParts ||
        !result.site.publicContact ||
        result.site.primaryContactUserId !== expectedManagerId
      ) {
        await adminApi.assignSiteUser(siteId, expectedManagerId, true);
        const repaired = await adminApi.updateSite(siteId, {
          name: result.site.name,
          addressParts,
          publicContact: {
            email: formValue(data, "public-contact-email"),
            phone: formValue(data, "public-contact-phone"),
            phoneExtension: formValue(data, "public-contact-extension"),
          },
          primaryContactUserId: expectedManagerId,
          siteType: controlValue(form, "site-type"),
        });
        result.site = repaired.site;
        if (
          !repaired.site?.addressParts ||
          !repaired.site?.publicContact ||
          repaired.site?.primaryContactUserId !== expectedManagerId
        ) {
          throw new Error("site_creation_incomplete");
        }
        savedSite = repaired.site;
      }
      if (staff) {
        const existing = await adminApi.listManagerMemberships(siteId);
        const memberships = existing.memberships || [];
        if (
          !memberships.some((member) => member.userId === expectedManagerId)
        ) {
          const created = await adminApi.createManagerMembership(
            siteId,
            `${staff.firstName} ${staff.lastName}`.trim(),
            staff.email,
            programId,
            expectedManagerId,
          );
          memberships.push(created.membership);
        }
        savedSite = {
          ...savedSite,
          managerMemberships: siteManagerRoster([], memberships),
        };
      }
      this.state.sites = upsertRecord(this.state.sites, savedSite, "siteId");
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      this.managerDirectoryLoader = null;
      this.state.managerDirectoryLoaded = false;
      syncDirtyForm(form, true);
      delete form.dataset.saving;
      feedback.success();
      if (location.pathname + location.search !== origin) return;
      this.state.site = null;
      this.state.error = "";
      navigate(`/sites/${encodeURIComponent(siteId)}`);
    } catch (error) {
      feedback.failure(error, {
        inlineAvailable: form.isConnected,
        message: siteSaveErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Deactivate a provider and return to the provider list.
   * @param {string} providerId
   * @returns {Promise<void>}
   */
  async deactivateProvider(providerId) {
    const feedback = actionFeedback("admin.toast.providerDeactivated");
    try {
      await adminApi.deactivateProvider(providerId);
      feedback.success();
      this.state.provider = null;
      this.state.site = null;
      await this.loadProviders();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /**
   * @param {HTMLFormElement} form
   * @param {"all" | "details" | "address" | "lead-program" | "site-manager"} [section]
   */
  async updateSite(form, section = "all") {
    if (form.dataset.readOnly === "true") return false;
    const feedback = actionFeedback("admin.toast.siteSaved");
    try {
      if (!this.state.site) return;
      const data = new FormData(form);
      const name = formValue(data, "site-name");
      const leadProgramId = formValue(data, "lead-program-id");
      const leadProviderId =
        formValue(data, "lead-provider-id") || this.state.site.providerId;
      const addressParts = data.has("street-address")
        ? addressPartsFromForm(data)
        : null;
      const publicContact = {
        email: formValue(data, "public-contact-email"),
        phone: formValue(data, "public-contact-phone"),
        phoneExtension: formValue(data, "public-contact-extension"),
      };
      /** @type {Record<string, unknown>} */
      const values = {
        name:
          section === "all" || section === "details"
            ? name
            : this.state.site.name,
      };
      if (section === "all" || section === "details")
        values.publicContact = publicContact;
      if (section === "all" || section === "details")
        values.siteType = controlValue(form, "site-type");
      if (
        (section === "all" || section === "address") &&
        addressParts &&
        hasEnteredValues(addressParts)
      )
        values.addressParts = addressParts;
      this.state.siteSaving = true;
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      try {
        if (
          (section === "all" || section === "lead-program") &&
          (leadProgramId !== String(this.state.site.leadProgramId || "") ||
            leadProviderId !== this.state.site.providerId)
        ) {
          const leadProgram = selectedLeadProgram(
            this.state.programs,
            leadProgramId,
          );
          if (!leadProgramId || !leadProgram?.providerId) {
            throw new Error("lead_program_required");
          }
          const reassignment = await adminApi.reassignSite(
            this.state.site.siteId,
            leadProviderId,
            leadProgramId,
            { expectedUpdatedAt: form.dataset.reassignmentVersion },
          );
          feedback.changed();
          this.state.site = { ...this.state.site, ...reassignment.site };
        }
        if (section === "lead-program") {
          feedback.success("admin.toast.leadProgramSaved");
          this.state.siteSaveMessage = "";
          return true;
        }
        const result = await adminApi.updateSite(
          this.state.site.siteId,
          values,
        );
        feedback.changed();
        this.state.site = { ...this.state.site, ...result.site };
        this.state.sites = this.state.sites.map((site) =>
          site.siteId === this.state.site?.siteId
            ? { ...site, ...this.state.site }
            : site,
        );
        if (values.addressParts && !hasSiteCoordinates(result.site?.location)) {
          this.state.siteSaveError =
            "The address was saved, but geocoding did not return coordinates. Try saving it again.";
          feedback.success("admin.toast.addressCoordinatesMissing", "info");
          return false;
        }
        feedback.success(
          section === "address"
            ? "admin.toast.addressSaved"
            : "admin.toast.siteSaved",
        );
        this.state.siteSaveMessage = "";
        return true;
      } catch (error) {
        feedback.failure(error);
        this.state.siteSaveError = siteSaveErrorMessage(error);
        return false;
      } finally {
        this.state.siteSaving = false;
        if (this.state.siteSaveError) {
          showFormSaveError(form, this.state.siteSaveError);
        } else {
          this.render();
        }
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async updateOversight(form) {
    const feedback = actionFeedback("admin.toast.oversightSaved");
    try {
      if (!this.state.site) return false;
      const managerIds = [
        ...form.querySelectorAll("input[name='compliance-manager-id']"),
      ].map((input) => input.value);
      const oversight = {
        managingCityDepartment: controlValue(form, "managing-city-department"),
        managingSystemOfCare: controlValue(form, "managing-system-of-care"),
      };
      const currentManagerIds = this.state.assignedComplianceManagers
        .map((manager) => String(manager.managerId || manager.userId || ""))
        .filter(Boolean)
        .sort();
      const nextManagerIds = [...managerIds].sort();
      const assignmentsChanged =
        currentManagerIds.length !== nextManagerIds.length ||
        currentManagerIds.some(
          (managerId, index) => managerId !== nextManagerIds[index],
        );
      this.state.siteSaving = true;
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      this.state.error = "";
      if (managerIds.length > 2) {
        this.state.siteSaveError =
          "A site can have no more than two Program managers.";
        showFormSaveError(form, this.state.siteSaveError);
        return false;
      }
      try {
        const result = await adminApi.updateSite(this.state.site.siteId, {
          name: this.state.site.name,
          oversight,
        });
        feedback.changed();
        if (
          this.state.capabilities.createEntities === true &&
          assignmentsChanged
        ) {
          const assignmentResult = await adminApi.replaceSiteComplianceManagers(
            this.state.site.siteId,
            managerIds,
          );
          this.state.assignedComplianceManagers =
            assignmentResult.assignments || [];
        }
        this.state.site = { ...this.state.site, ...result.site };
        this.state.sites = this.state.sites.map((site) =>
          site.siteId === this.state.site?.siteId
            ? { ...site, ...this.state.site }
            : site,
        );
        feedback.success();
        this.state.siteSaveMessage = "";
        return true;
      } catch (error) {
        feedback.failure(error);
        this.state.siteSaveError = siteSaveErrorMessage(error);
        return false;
      } finally {
        this.state.siteSaving = false;
        if (this.state.siteSaveError) {
          showFormSaveError(form, this.state.siteSaveError);
        } else {
          this.render();
        }
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async updatePerimeter(form) {
    const feedback = actionFeedback("admin.toast.perimeterSaved");
    try {
      if (!this.state.site) return false;
      const perimeter = formValue(new FormData(form), "perimeter");
      if (!perimeter) {
        showFormSaveError(form, "Enter a perimeter description before saving.");
        return false;
      }
      this.state.perimeterSaving = true;
      this.state.perimeterMessage = "";
      this.state.perimeterError = "";
      this.state.physicalDeviceRevocationPreview = null;
      this.state.emergencyRevocationSites = [];
      this.state.emergencyRevocationPreview = null;
      this.state.suspensionTarget = null;
      this.state.revocationMessage = "";
      this.render();
      try {
        const result = await adminApi.updateSitePerimeter(
          this.state.site.siteId,
          perimeter,
          String(this.state.site.updatedAt || ""),
        );
        this.state.site = { ...this.state.site, ...result };
        feedback.success();
        this.state.perimeterMessage = "";
        return true;
      } catch (error) {
        feedback.failure(error);
        this.state.perimeterError =
          error instanceof Error &&
          error.message === "perimeter_update_conflict"
            ? "This Site changed after you opened it. Reload the latest version before saving."
            : "The perimeter could not be saved. Check the text and try again.";
        return false;
      } finally {
        this.state.perimeterSaving = false;
        if (this.state.perimeterError) {
          showFormSaveError(form, this.state.perimeterError);
        } else {
          this.render();
        }
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /**
   * Open a site with its contacts and devices.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async openSite(siteId, updateUrl = true, refresh = true, renderNow = true) {
    if (updateUrl) return navigate(`/sites/${encodeURIComponent(siteId)}`);
    const path = location.pathname + location.search;
    const generation = (this.siteLoadGeneration =
      (this.siteLoadGeneration || 0) + 1);
    const requested =
      new URLSearchParams(location.search).get("section") || "details";
    const section =
      {
        staff: "details",
        terms: "compliance",
        letters: "compliance",
        perimeter: "compliance",
      }[requested] || requested;
    const sameSite = this.state.site?.siteId === siteId;
    this.siteSectionLoads ||= new Map();
    if (!sameSite || refresh) this.siteSectionLoads.clear();
    if (
      !refresh &&
      sameSite &&
      !this.programManagersStale &&
      Date.now() - (this.siteSectionLoads.get(section) || 0) < 30000
    ) {
      this.render();
      if (
        section === "compliance" &&
        this.state.expandedLettersSiteId === siteId
      )
        void this.loadSiteLetters(siteId);
      queueMicrotask(() => {
        const heading = this.querySelector("h1");
        heading?.focus({ preventScroll: true });
        heading?.ownerDocument.defaultView?.scrollTo({
          top: 0,
          left: 0,
          behavior: "instant",
        });
      });
      return;
    }
    if (!sameSite) {
      this.state.expandedLettersSiteId = null;
      this.state.expandedTermsSiteId = null;
      this.state.letterHistoryCursor = "";
    }
    this.siteReadController?.abort();
    const controller = (this.siteReadController = new AbortController());
    const needsRoster = ["details", "access", "compliance"].includes(section);
    const [
      site,
      memberships,
      grants,
      devices,
      terms,
      programManagers,
      peopleResult,
    ] = await Promise.all([
      adminApi.getSite(siteId, false, section, controller.signal),
      section === "access" ? adminApi.listManagerMemberships(siteId) : null,
      section === "access" ? adminApi.listManagerGrants(siteId) : null,
      section === "access" ? adminApi.listDevices(siteId) : null,
      section === "compliance" ? adminApi.listSiteTerms(siteId) : null,
      this.programManagersStale ? adminApi.listCityProgramManagers() : null,
      needsRoster ? adminApi.listPeople() : null,
    ]);
    const latest = site.items?.find((item) => item.sk === "#META");
    const program =
      needsRoster && latest?.leadProgramId
        ? await adminApi.getProgram(latest.leadProgramId)
        : null;
    if (
      generation !== this.siteLoadGeneration ||
      location.pathname + location.search !== path
    )
      return;
    if (programManagers) {
      this.state.programManagers = programManagers.programManagers || [];
      this.programManagersStale = false;
    }
    this.state.siteCanEdit = site.permissions?.canEdit === true;
    if (section === "compliance" || !sameSite) {
      this.state.letterEmailUncertain = (site.items || []).some(
        (item) => item.deliveryState === "uncertain",
      );
      this.state.letterEmailHistory = (site.items || []).filter(
        (item) => item.type === "complianceLetterEmail",
      );
    }
    this.state.site = latest
      ? { ...(sameSite ? this.state.site : {}), ...latest }
      : null;
    if (this.state.site) {
      const current = this.state.site;
      this.state.sites = this.state.sites.map((summary) =>
        summary.siteId === siteId
          ? {
              ...summary,
              ...current,
              primaryContactUserId: current.primaryContactUserId,
              primaryContact: current.primaryContact,
            }
          : summary,
      );
    }
    if (needsRoster) {
      this.state.assignedUsers = (site.items || []).filter((item) =>
        String(item.sk || "").startsWith("ASSIGNED_USER#"),
      );
    }
    this.state.assignedComplianceManagers = (site.items || [])
      .filter((item) => String(item.sk || "").startsWith("COMPLIANCE_MANAGER#"))
      .map((assignment) => ({
        ...assignment,
        ...this.state.programManagers.find(
          (manager) => manager.userId === assignment.managerId,
        ),
      }));
    const people =
      peopleResult?.people || (sameSite ? this.state.people || [] : []);
    this.state.people = people;
    if (needsRoster)
      this.state.availableSiteUsers = [
        ...people.map((person) => ({ ...person, userId: person.personId })),
        ...(program?.users || []).filter(
          (user) => user.status !== "inactive" && !user.personId,
        ),
      ];
    if (terms) this.state.siteTerms = terms.terms || [];
    else if (!sameSite) this.state.siteTerms = [];
    this.state.provider = null;
    this.state.program = null;
    this.state.siteManager = null;
    if (needsRoster) {
      this.state.managerMemberships = siteManagerRoster(
        this.state.assignedUsers,
        memberships?.memberships ||
          (site.items || []).filter(
            (item) => item.type === "managerMembership",
          ),
        this.state.availableSiteUsers,
      );
      this.state.managerMemberships = this.state.managerMemberships.map(
        (member) => {
          const person = people.find((p) => p.personId === member.personId);
          return person
            ? {
                ...member,
                firstName: person.firstName,
                lastName: person.lastName,
                name: person.name,
                email: person.email,
              }
            : member;
        },
      );
      this.state.assignedUsers = this.state.managerMemberships
        .filter(
          (membership) =>
            (membership.personId || membership.userId) &&
            this.state.availableSiteUsers.some(
              (user) =>
                user.userId === (membership.personId || membership.userId),
            ),
        )
        .map((membership) => ({
          ...membership,
          ...(this.state.availableSiteUsers.find(
            (user) =>
              user.userId === (membership.personId || membership.userId),
          ) || {}),
        }));
      this.state.sites = this.state.sites.map((summary) =>
        summary.siteId === siteId
          ? { ...summary, managerMemberships: this.state.managerMemberships }
          : summary,
      );
    }
    if (grants) this.state.managerGrants = grants.grants || [];
    else if (!sameSite) this.state.managerGrants = [];
    if (devices) this.state.devices = devices.devices || [];
    else if (!sameSite) this.state.devices = [];
    this.state.issuedCode = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.perimeterSaving = false;
    this.state.perimeterMessage = "";
    this.state.perimeterError = "";
    this.siteSectionLoads.set(section, Date.now());
    if (renderNow) {
      this.render();
      if (
        section === "compliance" &&
        this.state.expandedLettersSiteId === siteId
      )
        void this.loadSiteLetters(siteId);
    }
    if (renderNow)
      queueMicrotask(() => {
        const heading = this.querySelector("h1");
        heading?.focus({ preventScroll: true });
        // Navigation starts at the page top, independently of the heading's position.
        if (!refresh)
          heading?.ownerDocument.defaultView?.scrollTo({
            top: 0,
            left: 0,
            behavior: "instant",
          });
      });
  }

  async createSiteTerms(form) {
    const feedback = actionFeedback("admin.toast.letterQueued");
    try {
      if (!this.state.site) return false;
      const reasons = selectedComplianceReasons(form);
      const siteId = this.state.site.siteId;
      const queued = await adminApi.createSiteTerms(this.state.site.siteId, {
        reasons,
        siteManagerUserId: controlValue(form, "terms-site-manager-id"),
        requiredChecksPerDay: Number(
          controlValue(form, "terms-checks-per-day"),
        ),
        periodEnd: controlValue(form, "terms-expiry"),
      });
      feedback.success("admin.toast.letterQueued", "info");
      window.history.replaceState(
        {},
        "",
        `/sites/${encodeURIComponent(siteId)}?section=compliance`,
      );
      await this.openSite(siteId, false, true, false);
      this.state.expandedLettersSiteId = siteId;
      this.state.siteSaveMessage = t("admin.letters.pending");
      this.render();
      void this.loadSiteLetters(siteId);
      void this.refreshPendingComplianceLetter(siteId);
      void this.refreshLetterEmails(siteId, queued.jobId);
      return true;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async readLetterStatus(siteId) {
    this.letterStatusReads ||= new Map();
    const cached = this.letterStatusReads.get(siteId);
    if (cached && Date.now() - cached.at < 1000) return cached.promise;
    const promise = adminApi.getSite(siteId, false, "status");
    this.letterStatusReads.set(siteId, { at: Date.now(), promise });
    try {
      return await promise;
    } catch (error) {
      this.letterStatusReads.delete(siteId);
      throw error;
    }
  }

  async loadSiteLetters(siteId, more = false) {
    const generation = this.siteLoadGeneration;
    const path = location.pathname + location.search;
    if (
      this.lettersLoading?.siteId === siteId &&
      this.lettersLoading.generation === generation &&
      this.lettersLoading.path === path
    )
      return;
    const request = { siteId, generation, path };
    this.lettersLoading = request;
    const isCurrent = () =>
      this.lettersLoading === request &&
      this.siteLoadGeneration === generation &&
      location.pathname + location.search === path &&
      this.state.site?.siteId === siteId &&
      currentRoute().name === "site";
    try {
      const result = await adminApi.getSiteLetters(
        siteId,
        more ? this.state.letterHistoryCursor || "" : "",
      );
      if (!isCurrent()) return;
      const latest = result.items.find((item) => item.sk === "#META");
      this.state.site = { ...this.state.site, ...latest };
      this.state.letterEmailHistory = [
        ...(more ? this.state.letterEmailHistory : []),
        ...result.items.filter((item) => item.type === "complianceLetterEmail"),
      ];
      this.state.letterEmailUncertain = [
        ...this.state.letterEmailHistory,
        ...result.items.filter((item) => item.type !== "complianceLetterEmail"),
      ].some((item) => item.deliveryState === "uncertain");
      this.state.letterHistoryCursor = result.nextCursor;
      this.renderLetterStatus();
    } catch (error) {
      if (isCurrent()) actionFeedback("admin.toast.failed").failure(error);
    } finally {
      if (this.lettersLoading === request) this.lettersLoading = null;
    }
  }

  renderLetterStatus() {
    const panel = this.querySelector('[aria-labelledby="letters-title"]');
    if (!panel || this.letterResendPending === this.state.site?.siteId) return;
    const focused = document.activeElement;
    const focusSelector = panel.contains(focused)
      ? focused?.closest("#more-letter-history")
        ? "#more-letter-history"
        : focused?.closest("summary")
          ? "summary"
          : null
      : null;
    const template = document.createElement("template");
    template.innerHTML = siteLettersView(this.state);
    panel.replaceWith(template.content.firstElementChild);
    this.bindLetterActions();
    this.applyCapabilities();
    if (focusSelector) {
      const replacement = this.querySelector(
        '[aria-labelledby="letters-title"]',
      );
      (
        replacement?.querySelector(focusSelector) ||
        replacement?.querySelector("summary")
      )?.focus({ preventScroll: true });
    }
  }

  async refreshPendingComplianceLetter(siteId) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)),
      );
      if (this.state.site?.siteId !== siteId || currentRoute().name !== "site")
        return;
      if (document.hidden) continue;
      try {
        const result = await this.readLetterStatus(siteId);
        const latest = result.items?.find((item) => item.sk === "#META");
        if (!latest || latest.letterState === "draft_pending") continue;
        this.state.site = { ...this.state.site, ...latest };
        if (this.state.expandedLettersSiteId === siteId)
          await this.loadSiteLetters(siteId);
        return;
      } catch {
        /* Retry reads, never repeat the write. */
      }
    }
  }

  async refreshLetterEmails(siteId, jobId) {
    this.activeLetterJobs ||= new Set();
    this.notifiedLetterJobs ||= new Set();
    if (this.activeLetterJobs.has(jobId) || this.notifiedLetterJobs.has(jobId))
      return;
    this.activeLetterJobs.add(jobId);
    let elapsed = 0;
    const deadline = Date.now() + 60000;
    try {
      while (elapsed < 60000 && Date.now() < deadline) {
        const delay = Math.min(
          this.state.site?.siteId === siteId
            ? Math.min(1000 + elapsed / 2, 5000)
            : 5000,
          60000 - elapsed,
          Math.max(0, deadline - Date.now()),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        elapsed += delay;
        if (document.hidden) continue;
        try {
          const result = await this.readLetterStatus(siteId);
          const progress = letterEmailProgress(result.items || [], jobId);
          const changed =
            progress.history.length !==
              (this.state.letterEmailHistory?.length || 0) ||
            progress.uncertain !== Boolean(this.state.letterEmailUncertain);
          const isCurrentSite = this.state.site?.siteId === siteId;
          if (isCurrentSite) {
            // Status reads omit document links; retain the rendered history.
            this.state.letterEmailUncertain = progress.uncertain;
            if (progress.sent) {
              this.state.siteSaveMessage = t(
                progress.sent.provider === "local-preview"
                  ? "admin.letters.previewSent"
                  : "admin.letters.sent",
              );
            }
          }
          if (progress.sent || progress.currentUncertain) {
            this.notifiedLetterJobs ||= new Set();
            if (!this.notifiedLetterJobs.has(jobId)) {
              this.notifiedLetterJobs.add(jobId);
              notifyAdmin(
                progress.sent
                  ? progress.sent.provider === "local-preview"
                    ? "admin.letters.previewSent"
                    : "admin.letters.sent"
                  : "admin.toast.deliveryUncertain",
                progress.sent ? "success" : "info",
              );
            }
          }
          if (
            isCurrentSite &&
            (changed || progress.sent) &&
            this.state.expandedLettersSiteId === siteId
          )
            await this.loadSiteLetters(siteId);
          if (progress.sent || progress.currentUncertain) return;
        } catch {
          /* Retry reads without repeating the send. */
        }
      }
      this.notifiedLetterJobs.add(jobId);
      notifyAdmin("admin.toast.letterStillPending", "info");
    } finally {
      this.activeLetterJobs.delete(jobId);
    }
  }

  async endSiteTerms() {
    const feedback = actionFeedback("admin.toast.requirementEnded");
    try {
      if (!this.state.site) return;
      const siteId = this.state.site.siteId;
      await adminApi.endSiteTerms(siteId);
      feedback.success();
      await this.openSite(siteId, false, true, false);
      this.state.expandedTermsSiteId = siteId;
      this.state.siteSaveMessage = "";
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async previewSiteImport(form) {
    const input = /** @type {HTMLInputElement | null} */ (
      form.querySelector('input[type="file"]')
    );
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error("invalid_file_size");
    this.state.importBusy = true;
    this.state.error = "";
    this.render();
    try {
      this.state.importPreview = await adminApi.previewSiteImport(
        file.name,
        await file.text(),
      );
      this.state.importResult = null;
      this.state.importApplyKey = crypto.randomUUID();
      sessionStorage.setItem(
        `site-import-key:${this.state.importPreview.importId}`,
        this.state.importApplyKey,
      );
      window.history.pushState(
        {},
        "",
        `/sites/import?importId=${encodeURIComponent(this.state.importPreview.importId)}`,
      );
    } finally {
      this.state.importBusy = false;
      this.render();
    }
  }

  async applySiteImport() {
    const feedback = actionFeedback("admin.toast.importComplete");
    try {
      const preview = this.state.importPreview;
      if (!preview) return;
      this.state.importBusy = true;
      this.render();
      try {
        let result;
        do {
          result = await adminApi.applySiteImport(
            preview.importId,
            preview.previewVersion,
            this.state.importApplyKey,
          );
          if (Number(result.outcomes?.applied || 0) > 0) feedback.changed();
          this.state.importResult = result;
          if (result.rows) this.state.importPreview.rows = result.rows;
          const progress = this.querySelector(".import-progress span");
          if (progress)
            progress.textContent = t("admin.import.outcomeCounts", {
              applied: Number(result.outcomes?.applied || 0),
              failed: Number(result.outcomes?.failed || 0),
            });
        } while (result.status === "applying");
        if (result.status === "complete") {
          const failed =
            Number(result.outcomes?.failed || 0) +
            Number(result.outcomes?.skipped_conflict || 0);
          const applied = Number(result.outcomes?.applied || 0);
          if (
            result.resultStatus === "failed" ||
            (failed > 0 && applied === 0)
          ) {
            feedback.success(
              result.outcomes?.applied
                ? "admin.toast.importPartial"
                : "admin.toast.importFailed",
              applied > 0 ? "info" : "error",
            );
          } else if (result.resultStatus === "partial" || failed > 0) {
            feedback.success(
              result.outcomes?.applied
                ? "admin.toast.importPartial"
                : "admin.toast.importFailed",
              applied > 0 ? "info" : "error",
            );
          } else {
            feedback.success("admin.toast.importComplete", "success", {
              count: applied,
            });
            this.state.importNotice = null;
          }
          this.state.importNotice =
            failed > 0 ||
            result.resultStatus === "failed" ||
            result.resultStatus === "partial"
              ? {
                  title: t(
                    applied > 0
                      ? "admin.toast.importPartial"
                      : "admin.toast.importFailed",
                  ),
                  message: t("admin.import.outcomeCounts", { applied, failed }),
                }
              : null;
          sessionStorage.removeItem(`site-import-key:${preview.importId}`);
          this.state.importPreview = null;
          this.state.importResult = null;
          this.state.importApplyKey = "";
          try {
            const history = await adminApi.listSiteImports();
            this.state.importHistory = history.imports || [];
          } catch {
            notifyAdmin("admin.import.historyRefreshFailed", "info");
          }
          this.directoryLoaded = false;
          this.catalogsLoaded = false;
          this.state.managerDirectoryLoaded = false;
          this.managerDirectoryVersion =
            (this.managerDirectoryVersion || 0) + 1;
          if (currentRoute().name === "site-import")
            window.history.replaceState({}, "", "/sites/import");
        }
      } finally {
        this.state.importBusy = false;
        if (currentRoute().name === "site-import") this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  cancelSiteImport() {
    const importId = this.state.importPreview?.importId;
    if (importId) sessionStorage.removeItem(`site-import-key:${importId}`);
    this.state.importPreview = null;
    this.state.importResult = null;
    this.state.importApplyKey = "";
    this.state.importBusy = false;
    this.state.error = "";
    window.history.replaceState({}, "", "/sites/import");
    this.render();
    queueMicrotask(() =>
      this.querySelector('input[name="site-import-file"]')?.focus(),
    );
  }

  async downloadImportConflicts() {
    const feedback = actionFeedback("admin.toast.failed");
    try {
      const importId = this.state.importPreview?.importId;
      if (!importId) return;
      const blob = await adminApi.downloadSiteImportConflicts(importId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `site-import-${importId}-conflicts.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /**
   * Deactivate a site and refresh the current provider.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async deactivateSite(siteId) {
    const feedback = actionFeedback("admin.toast.siteDeactivated");
    try {
      await adminApi.deactivateSite(siteId);
      feedback.success();
      this.state.sites = this.state.sites.filter(
        (site) => site.siteId !== siteId,
      );
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      this.state.site = null;
      this.querySelector("[data-dirty-form]")?.setAttribute(
        "data-is-dirty",
        "false",
      );
      this.lastRenderedPath = "";
      navigate("/sites");
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {HTMLFormElement} form */
  async createSiteManagerFromAccess(form) {
    const feedback = actionFeedback("admin.toast.managerAssigned");
    try {
      if (form.dataset.saving) return;
      form.dataset.saving = "true";
      const save = form.querySelector('button[type="submit"]');
      const cancel = form.querySelector("[data-cancel-new-site-manager]");
      save.disabled = true;
      cancel.disabled = true;
      const siteId = this.state.site.siteId;
      const programId = this.state.site.leadProgramId;
      try {
        const data = new FormData(form);
        const values = {
          firstName: formValue(data, "new-manager-first-name"),
          lastName: formValue(data, "new-manager-last-name"),
          phone: formValue(data, "new-manager-phone"),
          phoneExtension: formValue(data, "new-manager-extension"),
          email: formValue(data, "new-manager-email"),
          siteManager: true,
        };
        this.pendingManagerCreations ||= new Map();
        const pendingUser = this.pendingManagerCreations.get(
          JSON.stringify([siteId, programId, values]),
        );
        if (pendingUser) {
          feedback.changed();
          form.dataset.createdUser = JSON.stringify(pendingUser);
        }
        await createAndAssignManager(
          this.pendingManagerCreations,
          { siteId, programId, values },
          {
            createProgramUser: async (...args) => {
              const created = await adminApi.createPerson({
                ...args[1],
                siteId,
              });
              const result = {
                user: { ...created.person, userId: created.person.personId },
              };
              feedback.changed();
              form.dataset.createdUser = JSON.stringify(result.user);
              return result;
            },
            createManagerMembership: async (
              siteId,
              name,
              email,
              programId,
              userId,
            ) =>
              adminApi.assignPersonToSite(siteId, {
                personId: userId,
                name,
                email,
              }),
          },
        );
        feedback.success();
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(
          form,
          form.dataset.createdUser
            ? t("admin.siteManagers.assignmentError")
            : adminErrorMessage(error, t, t("admin.programs.staffSaveError")),
        );
        delete form.dataset.saving;
        save.disabled = false;
        cancel.disabled = false;
        return;
      }
      form.closest("dialog")?.close();
      try {
        await this.openSite(siteId, false);
        this.querySelector("#manager-membership-form wa-select")?.focus();
      } catch (error) {
        feedback.failure(error);
        this.state.error = error.message;
        this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async addManagerMembership(form) {
    const feedback = actionFeedback("admin.toast.managerAssigned");
    try {
      if (!this.state.site) return;
      const data = new FormData(form);
      const user = this.state.availableSiteUsers.find(
        (item) => item.userId === formValue(data, "manager-user-id"),
      );
      if (!user?.email) throw new Error(t("admin.relationships.chooseManager"));
      if (user.personId)
        await adminApi.assignPersonToSite(this.state.site.siteId, user);
      else
        await adminApi.createManagerMembership(
          this.state.site.siteId,
          `${user.firstName} ${user.lastName}`.trim(),
          user.email,
          this.state.site.leadProgramId,
          user.userId,
        );
      feedback.success();
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      form.reset();
      await this.openSite(this.state.site.siteId, false);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {HTMLFormElement} form */
  async saveWithFeedback(form, save) {
    return withSaveFeedback(form, save, {
      savingLabel: t("siteAdmin.edit.saving"),
      onError: (error) => showFormSaveError(form, adminErrorMessage(error, t)),
    });
  }

  async saveSiteManager(form) {
    return this.saveWithFeedback(form, () => this.persistSiteManager(form));
  }

  async persistSiteManager(form) {
    const feedback = actionFeedback("admin.toast.managerSaved");
    try {
      const origin = location.pathname + location.search;
      const data = new FormData(form);
      const current = this.state.siteManager;
      if (!current || current.personId)
        return this.persistPersonManager(form, current, feedback);
      const canManageAssignments =
        this.state.capabilities.createEntities === true;
      const programId = canManageAssignments
        ? formValue(data, "manager-program-id")
        : current?.programId || "";
      const programChanged = Boolean(
        current && current.programId !== programId,
      );
      const values = {
        firstName: formValue(data, "manager-first-name"),
        lastName: formValue(data, "manager-last-name"),
        phone: formValue(data, "manager-phone"),
        phoneExtension: formValue(data, "manager-phone-extension"),
        email: canManageAssignments
          ? formValue(data, "manager-email")
          : current?.email || "",
        siteManager: true,
      };
      const siteIds = canManageAssignments
        ? data.getAll("manager-site-id").map(String)
        : (current?.assignedSites || []).map((site) => site.siteId);
      const fullName = `${values.firstName} ${values.lastName}`.trim();
      try {
        let response;
        if (programChanged) {
          const targetProgram = await adminApi.getProgram(programId);
          const targetUser = (targetProgram.users || []).find(
            (user) =>
              user.status !== "inactive" &&
              String(user.email || "").toLowerCase() ===
                values.email.toLowerCase(),
          );
          response = targetUser
            ? await adminApi.updateProgramUser(
                programId,
                targetUser.userId,
                values,
              )
            : await adminApi.createProgramUser(programId, values);
        } else {
          response = current
            ? await adminApi.updateProgramUser(
                programId,
                current.userId,
                values,
              )
            : await adminApi.createProgramUser(programId, values);
        }
        feedback.changed();
        const user = response.user;
        const existing = new Map(
          (current?.assignedSites || []).map((site) => [site.siteId, site]),
        );
        const selected = new Set(siteIds);
        const savedAssignments = new Map(existing);
        // Assignment counts belong to this one staff record. Apply Site changes
        // serially so each transaction observes the count written by the last.
        for (const siteId of siteIds) {
          const membership = existing.get(siteId);
          if (membership?.legacyAssignment && !canManageAssignments) continue;
          if (membership && !membership.legacyAssignment) {
            const result = await adminApi.updateManagerMembership(
              siteId,
              membership.membershipId,
              fullName,
              values.email,
            );
            savedAssignments.set(siteId, {
              ...membership,
              ...result.membership,
            });
          } else {
            const result = await adminApi.createManagerMembership(
              siteId,
              fullName,
              values.email,
              programId,
              user.userId,
            );
            savedAssignments.set(siteId, { ...result.membership, siteId });
          }
        }
        for (const [siteId, membership] of existing) {
          if (selected.has(siteId)) continue;
          if (membership.legacyAssignment)
            await adminApi.unassignSiteUser(siteId, membership.userId);
          else
            await adminApi.deactivateManagerMembership(
              siteId,
              membership.membershipId,
            );
        }
        if (programChanged) {
          await adminApi.updateProgramUser(current.programId, current.userId, {
            ...values,
            siteManager: false,
          });
        }
        const program = this.state.programs.find(
          (item) => item.programId === programId,
        );
        const savedManager = {
          ...user,
          programId,
          programName: program?.name || "",
          providerId: program?.providerId || "",
          assignedSites: siteIds.map((siteId) => ({
            ...savedAssignments.get(siteId),
            siteId,
            siteName:
              this.state.sites.find((site) => site.siteId === siteId)?.name ||
              "",
          })),
        };
        this.state.siteManagers = upsertRecord(
          this.state.siteManagers.filter(
            (manager) => !programChanged || manager.userId !== current.userId,
          ),
          savedManager,
          "userId",
        );
        feedback.success();
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
        if (location.pathname + location.search !== origin) return true;
        this.state.siteManager = savedManager;
        this.state.siteSaveMessage = "";
        this.state.siteSaveError = "";
        if (form.dataset?.returnSite) {
          form.dataset.isDirty = "false";
          navigate(
            `/sites/${encodeURIComponent(form.dataset.returnSite)}?section=details`,
          );
          return true;
        }
        if (!current || user.userId !== current.userId) {
          window.history.replaceState(
            {},
            "",
            `/managers/${encodeURIComponent(user.userId)}`,
          );
        }
        this.render();
        return true;
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(form, managerSaveErrorMessage(error));
        return false;
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async persistPersonManager(form, current, feedback) {
    const origin = location.pathname + location.search;
    const data = new FormData(form);
    const supervisor = this.state.capabilities.createEntities;
    const values = {
      firstName: formValue(data, "manager-first-name"),
      lastName: formValue(data, "manager-last-name"),
      email: supervisor ? formValue(data, "manager-email") : current.email,
      phone: formValue(data, "manager-phone"),
      phoneExtension: formValue(data, "manager-phone-extension"),
      ...(supervisor
        ? {
            primaryProviderId: formValue(data, "manager-provider-id"),
            primaryProgramId: formValue(data, "manager-program-id"),
          }
        : {}),
    };
    const id = current?.personId || form.dataset.createdPersonId;
    const { person } = id
      ? await adminApi.updatePerson(id, values)
      : await adminApi.createPerson(values);
    form.dataset.createdPersonId = person.personId;
    feedback.changed();
    const selected = supervisor
      ? data.getAll("manager-site-id").map(String)
      : (current?.assignedSites || []).map((s) => s.siteId);
    const existing = (form.confirmedAssignments ||= new Map(
      (current?.assignedSites || []).map((s) => [s.siteId, s]),
    ));
    for (const siteId of selected) {
      if (existing.has(siteId)) continue;
      // Reconcile a prior uncertain write before retrying; never create twice.
      const { memberships = [] } =
        await adminApi.listManagerMemberships(siteId);
      let membership = memberships.find(
        (m) => m.personId === person.personId && m.status !== "inactive",
      );
      if (!membership)
        membership = (await adminApi.assignPersonToSite(siteId, person))
          .membership;
      const site = this.state.sites.find((s) => s.siteId === siteId);
      existing.set(siteId, {
        ...membership,
        siteId,
        siteName: site?.name,
        leadProgramId: site?.leadProgramId,
      });
    }
    for (const [siteId, membership] of existing) {
      if (selected.includes(siteId)) continue;
      try {
        await adminApi.deactivateManagerMembership(
          siteId,
          membership.membershipId,
        );
      } catch (error) {
        // Another editor may already have completed this exact removal.
        if (
          error.status !== 404 ||
          error.message !== "manager_membership_not_found"
        )
          throw error;
      }
      existing.delete(siteId);
    }
    this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
    const assignedSites = [...existing.values()];
    const manager = {
      ...current,
      ...person,
      userId: person.personId,
      programId: person.primaryProgramId || "",
      providerId: person.primaryProviderId || "",
      programName:
        this.state.programs.find((p) => p.programId === person.primaryProgramId)
          ?.name || "",
      assignedSites,
    };
    this.state.people = upsertRecord(
      this.state.people || [],
      person,
      "personId",
    );
    this.state.siteManagers = upsertRecord(
      this.state.siteManagers,
      manager,
      "userId",
    );
    this.state.sites = this.state.sites.map((site) => ({
      ...site,
      managerMemberships: [
        ...(site.managerMemberships || []).filter(
          (m) =>
            m.personId !== person.personId &&
            m.userId !== person.personId &&
            !(current?.legacyUserIds || []).includes(m.userId),
        ),
        ...assignedSites
          .filter((m) => m.siteId === site.siteId)
          .map((m) => ({ ...m, ...person, userId: person.personId })),
      ],
    }));
    feedback.success();
    form.dataset.isDirty = "false";
    if (location.pathname + location.search !== origin) return true;
    if (form.dataset.returnSite) {
      navigate(
        `/sites/${encodeURIComponent(form.dataset.returnSite)}?section=details`,
      );
      return true;
    }
    window.history.replaceState(
      {},
      "",
      `/managers/${encodeURIComponent(person.personId)}`,
    );
    this.state.siteManager = manager;
    this.render();
    return true;
  }

  async removeSiteManager() {
    const feedback = actionFeedback("admin.toast.managerDeleted");
    try {
      const manager = this.state.siteManager;
      const returnSite = new URLSearchParams(window.location.search).get(
        "returnSite",
      );
      if (!manager) return;
      try {
        await adminApi.removeSiteManager(manager.programId, manager.userId);
        feedback.success();
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
        this.state.siteManager = null;
        const form = this.querySelector("#site-manager-record-form");
        if (form) form.dataset.isDirty = "false";
        const affected = new Set(
          (manager.assignedSites || []).map((site) => site.siteId),
        );
        this.state.sites = this.state.sites.map((site) => {
          if (!affected.has(site.siteId)) return site;
          const { managerMemberships, ...rest } = site;
          return rest;
        });
        await this.loadSiteManagers(true);
        navigate(
          returnSite
            ? `/sites/${encodeURIComponent(returnSite)}?section=details`
            : "/managers",
        );
      } catch (error) {
        feedback.failure(error);
        this.state.error =
          error instanceof Error &&
          [
            "site_primary_contact_in_use",
            "program_primary_contact_in_use",
          ].includes(error.message)
            ? t("admin.programs.reassignPrimaryBeforeRemoval")
            : error instanceof Error &&
                error.message === "manager_removal_conflict"
              ? "The manager or one of their Site assignments changed. Reload and try again."
              : "The manager could not be removed. Try again.";
        this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {string} membershipId */
  async deactivateManagerMembership(membershipId) {
    const feedback = actionFeedback("admin.toast.managerRemoved");
    try {
      if (!this.state.site) return;
      const membership = this.state.managerMemberships.find(
        (item) => item.membershipId === membershipId,
      );
      const result = membership?.legacyAssignment
        ? {
            ...(await adminApi.unassignSiteUser(
              this.state.site.siteId,
              membership.userId,
            )),
            revokedBindingCount: 0,
          }
        : await adminApi.deactivateManagerMembership(
            this.state.site.siteId,
            membershipId,
          );
      feedback.success();
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      const siteId = this.state.site.siteId;
      await this.openSite(siteId, false);
      this.state.revocationMessage = `${membership?.name || "Site Manager"} removed; ${result.revokedBindingCount} Manager binding${result.revokedBindingCount === 1 ? "" : "s"} revoked at this Site.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {string} membershipId */
  openManagerMembershipRemoval(membershipId) {
    const membership = this.state.managerMemberships.find(
      (item) => item.membershipId === membershipId,
    );
    if (!membership) return;
    this.state.managerMembershipRemovalTarget = membership;
    this.render();
    this.querySelector("#remove-manager-membership-dialog")?.showModal();
  }

  /** @param {string} membershipId */
  async issueManagerGrant(membershipId, deliveryMode = "link") {
    if (this.state.error) {
      this.state.error = "";
      this.render();
    }
    const feedback = actionFeedback("admin.enrollment.emailed");
    try {
      if (!this.state.site) return;
      const membership = this.state.managerMemberships.find(
        (item) => item.membershipId === membershipId,
      );
      if (membership?.legacyAssignment) {
        const linked = await adminApi.createManagerMembership(
          this.state.site.siteId,
          membership.name,
          membership.email,
          this.state.site.leadProgramId,
          membership.userId,
        );
        feedback.changed();
        membershipId = linked.membership.membershipId;
        this.state.managerMemberships = this.state.managerMemberships.map(
          (item) => (item === membership ? linked.membership : item),
        );
        this.render();
      }
      const created = await adminApi.createManagerGrant(
        this.state.site.siteId,
        membershipId,
        deliveryMode,
      );
      feedback.success(
        created.grant?.deliveryStatus === "accepted"
          ? deliveryMode === "code"
            ? "admin.enrollment.codeEmailed"
            : "admin.enrollment.emailed"
          : "admin.toast.enrollmentEmailFailed",
        created.grant?.deliveryStatus === "accepted" ? "success" : "error",
      );
      if (
        (await this.refreshSiteAccess(this.state.site.siteId, false)) === false
      )
        return;
      this.state.managerGrants = attachCreatedEnrollmentUrl(
        this.state.managerGrants,
        created,
      );
      this.render();
    } catch (error) {
      if (error.message === "provider_manager_grant_already_active") {
        error.message = t("admin.enrollment.alreadyActive");
      } else if (
        ["provider_manager_grant_conflict", "manager_grant_conflict"].includes(
          error.message,
        )
      ) {
        error.message = t("admin.enrollment.conflict");
      }
      feedback.failure(error);
      throw error;
    }
  }

  /** @param {HTMLButtonElement} button */
  async copyManagerGrant(button) {
    const enrollmentUrl = dataAttr(button, "data-copy-enrollment-url");
    const status = button.parentElement?.querySelector("[data-copy-status]");
    const icon = button.querySelector("wa-icon");
    button.disabled = true;
    try {
      await copyEnrollmentUrl(enrollmentUrl);
      button.setAttribute("aria-label", "Enrollment link copied");
      icon?.setAttribute("name", "check");
      if (status) status.textContent = "Enrollment link copied.";
    } catch {
      notifyAdmin("admin.toast.copyFailed", "error");
      button.setAttribute("aria-label", "Copy enrollment link failed");
      if (status)
        status.textContent = "The enrollment link could not be copied.";
    } finally {
      button.disabled = false;
    }
  }

  /** @param {string} grantId */
  async cancelManagerGrant(grantId) {
    const feedback = actionFeedback("admin.toast.linkCancelled");
    try {
      if (!this.state.site) return;
      await adminApi.cancelManagerGrant(this.state.site.siteId, grantId);
      feedback.success();
      if ((await this.refreshSiteAccess(this.state.site.siteId)) === false)
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /**
   * Issue a setup code from the arbitrary email form.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async issueSetupCode(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    const email = data.get("setup-email");
    const accessLevel = data.get("setup-access");
    await this.issueSetupCodeForEmail(
      String(email || ""),
      accessLevel === "manager" ? "manager" : "general",
    );
    form.reset();
  }

  /**
   * Issue a setup code to a specific email on the currently open site.
   * @param {string} email
   * @returns {Promise<void>}
   */
  async issueSetupCodeForEmail(email, accessLevel = "general") {
    if (!this.state.site || !email.trim()) return;
    const result = await adminApi.issueSetupCode(
      this.state.site.siteId,
      email,
      accessLevel,
    );
    this.state.issuedCode = result.setupCode;
    this.render();
  }

  /**
   * Revoke a registered site device.
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async revokeDevice(deviceId) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.site) return;
      const device = this.state.devices.find(
        (item) => (item.bindingId || item.deviceId) === deviceId,
      );
      const label = device?.label || "this device";
      if (
        !globalThis.confirm(
          `Remove access for ${label} from ${this.state.site.name}? This ends this Site binding immediately. Other Site bindings on the same physical device are not affected.`,
        )
      ) {
        return;
      }
      const siteId = this.state.site.siteId;
      await adminApi.revokeDevice(siteId, deviceId);
      feedback.success();
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = `Access for ${label} was removed from this Site.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async revokeAllSiteDevices(form) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.site) return;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.revokeAllSiteDeviceBindings(
        this.state.site.siteId,
        confirmation,
      );
      feedback.success(
        result.status === "complete"
          ? "admin.toast.accessRemoved"
          : "admin.toast.revocationPartial",
        result.status === "complete" ? "success" : "info",
      );
      const siteId = this.state.site.siteId;
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage =
        result.status === "complete"
          ? `Operation ${result.operationId}: all Site credentials invalidated and ${result.affectedCount} device record${result.affectedCount === 1 ? "" : "s"} reconciled.`
          : `Operation ${result.operationId}: canonical Site credentials were invalidated, but ${result.failedCount} device record${result.failedCount === 1 ? "" : "s"} could not be reconciled. Follow the revocation runbook.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async beginPhysicalDeviceRevocation(physicalDeviceId) {
    if (!this.state.site) return;
    this.state.physicalDeviceRevocationPreview = (
      await adminApi.getPhysicalDevice(physicalDeviceId)
    ).physicalDevice;
    this.render();
    queueMicrotask(() =>
      this.querySelector("#physical-device-confirmation")?.focus(),
    );
  }

  /** @returns {any | undefined} */
  selectedDevice() {
    const selected = [...this.querySelectorAll("[data-device-selection]")].find(
      (input) => input.checked,
    );
    const bindingId = selected
      ? dataAttr(selected, "data-device-selection")
      : "";
    return this.state.devices.find(
      (device) => (device.bindingId || device.deviceId) === bindingId,
    );
  }

  /** @param {Element} changed */
  syncDeviceSelection(changed) {
    this.querySelectorAll("[data-device-selection]").forEach((input) => {
      if (input !== changed && changed.checked) input.checked = false;
    });
    const selected = this.selectedDevice();
    const actions = this.querySelector("#device-selection-actions");
    if (actions) actions.hidden = !selected;
    const allSitesButton = this.querySelector("#remove-device-all-sites");
    if (allSitesButton) {
      allSitesButton.hidden = !selected?.physicalDeviceId;
    }
  }

  async revokePhysicalDeviceEverywhere(form) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.site || !this.state.physicalDeviceRevocationPreview)
        return;
      const preview = this.state.physicalDeviceRevocationPreview;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.revokePhysicalDeviceEverywhere(
        preview.physicalDeviceId,
        confirmation,
      );
      feedback.success();
      const siteId = this.state.site.siteId;
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = result.alreadyRevoked
        ? "This physical device was already revoked."
        : `Operation ${result.operationId}: physical device revoked across ${result.affectedCount} Site binding${result.affectedCount === 1 ? "" : "s"}.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  async beginEmergencySiteRevocation() {
    const result = await adminApi.listEmergencyRevocationSites();
    this.state.emergencyRevocationSites = result.sites || [];
    this.state.emergencyRevocationPreview = null;
    this.render();
    queueMicrotask(() =>
      this.querySelector("#emergency-site-selection")?.focus(),
    );
  }

  async previewEmergencySiteRevocation(form) {
    const siteIds = new FormData(form)
      .getAll("site-id")
      .map((value) => String(value));
    if (siteIds.length < 2 || siteIds.length > 20) {
      this.state.error =
        "Select between two and 20 Sites for an emergency revocation.";
      this.render();
      return;
    }
    this.state.emergencyRevocationPreview =
      await adminApi.previewEmergencySiteRevocation(siteIds);
    this.render();
    queueMicrotask(() =>
      this.querySelector("#emergency-revocation-confirmation")?.focus(),
    );
  }

  async startEmergencySiteRevocation(form) {
    const feedback = actionFeedback("admin.toast.revocationStarted");
    try {
      const preview = this.state.emergencyRevocationPreview;
      if (!preview) return;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.startEmergencySiteRevocation(
        preview.sites.map((site) => site.siteId),
        confirmation,
      );
      feedback.success(
        result.enqueueFailedCount
          ? "admin.toast.revocationPartial"
          : "admin.toast.revocationStarted",
        "info",
      );
      this.state.emergencyRevocationSites = [];
      this.state.emergencyRevocationPreview = null;
      this.state.revocationMessage = `Operation ${result.operationId}: credentials invalidated across ${result.affectedSiteCount} Sites; ${result.queuedSiteCount} Site reconciliation job${result.queuedSiteCount === 1 ? "" : "s"} queued${result.enqueueFailedCount ? ` and ${result.enqueueFailedCount} require runbook follow-up` : ""}.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  beginDeviceSuspension(bindingId) {
    this.state.suspensionTarget =
      this.state.devices.find(
        (device) => (device.bindingId || device.deviceId) === bindingId,
      ) || null;
    this.render();
    queueMicrotask(() =>
      this.querySelector("#device-suspension-reason")?.focus(),
    );
  }

  async suspendDeviceBinding(form) {
    const feedback = actionFeedback("admin.toast.deviceSuspended");
    try {
      if (!this.state.site || !this.state.suspensionTarget) return;
      const reason = formValue(new FormData(form), "reason");
      const bindingId =
        this.state.suspensionTarget.bindingId ||
        this.state.suspensionTarget.deviceId;
      const result = await adminApi.suspendDeviceBinding(
        this.state.site.siteId,
        bindingId,
        reason,
      );
      feedback.success();
      const siteId = this.state.site.siteId;
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = result.alreadySuspended
        ? "This binding was already suspended."
        : `${result.binding.label || "Device binding"} suspended. Existing credentials are invalid; re-enrollment requires a new single-Site grant.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  }

  /**
   * Bind event handlers to the currently rendered DOM.
   * @returns {void}
   */
  renderDirectoryResults() {
    const current = this.querySelector("#directory-results");
    if (!current) return this.render();
    const template = document.createElement("template");
    template.innerHTML = directoryView(this.state, currentRoute());
    current.replaceChildren(
      ...template.content.querySelector("#directory-results").childNodes,
    );
    const clear = this.querySelector("#clear-directory-search");
    if (clear) clear.hidden = !new URLSearchParams(location.search).get("q");
    this.bindDirectoryFilters();
    this.applyCapabilities();
    this.lastRenderedPath = location.pathname + location.search;
  }

  bindDirectoryFilters() {
    this.querySelector("#site-directory-filters")?.addEventListener(
      "change",
      (event) => {
        const params = new URLSearchParams(window.location.search);
        const data = new FormData(asForm(event.currentTarget));
        for (const key of ["manager", "department", "system"]) {
          const value = String(data.get(key) || "");
          if (value || key === "manager") params.set(key, value);
          else params.delete(key);
        }
        const query = params.toString();
        navigate(`/sites${query ? `?${query}` : ""}`);
      },
    );
    this.querySelector("#manager-directory-filters")?.addEventListener(
      "change",
      (event) => {
        const params = new URLSearchParams(window.location.search);
        const data = new FormData(asForm(event.currentTarget));
        for (const key of ["program", "site"]) {
          const value = String(data.get(key) || "");
          if (value) params.set(key, value);
          else params.delete(key);
        }
        const query = params.toString();
        navigate(`/managers${query ? `?${query}` : ""}`);
      },
    );
  }

  bindLetterActions() {
    this.querySelector("[data-resend-letter]")?.addEventListener(
      "click",
      async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        const siteId = this.state.site.siteId;
        this.letterResendPending = siteId;
        const requestId = button.dataset.requestId || crypto.randomUUID();
        button.dataset.requestId = requestId;
        const feedback = actionFeedback("admin.toast.letterResendQueued");
        try {
          const queued = await adminApi.resendSiteLetter(siteId, requestId);
          feedback.success("admin.toast.letterResendQueued", "info");
          this.state.siteSaveMessage = t("admin.letters.resendQueued");
          this.letterResendPending = null;
          this.renderLetterStatus();
          void this.refreshLetterEmails(siteId, queued.jobId);
        } catch (error) {
          this.letterResendPending = null;
          feedback.failure(error);
          button.disabled = false;
          showFormSaveError(
            button.closest("section"),
            t("admin.letters.resendError"),
          );
        }
      },
    );
    this.querySelector("[data-site-letters]")?.addEventListener(
      "toggle",
      (event) => {
        if (!event.currentTarget.isConnected) return;
        const wasOpen =
          this.state.expandedLettersSiteId === this.state.site.siteId;
        this.state.expandedLettersSiteId = event.currentTarget.open
          ? this.state.site.siteId
          : null;
        if (event.currentTarget.open && !wasOpen)
          void this.loadSiteLetters(this.state.site.siteId);
      },
    );
    this.querySelector("#more-letter-history")?.addEventListener("click", () =>
      this.loadSiteLetters(this.state.site.siteId, true),
    );
  }

  bind() {
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
    this.querySelectorAll("[data-revoke-provider-devices]").forEach((form) => {
      const button = form.querySelector("button[type='submit']");
      const sync = () => {
        button.disabled =
          form.dataset.saving === "true" ||
          controlValue(form, "confirmation") !== form.dataset.confirmation;
      };
      form.addEventListener("input", sync);
      form.addEventListener("change", sync);
      sync();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (controlValue(form, "confirmation") !== form.dataset.confirmation)
          return;
        await this.saveWithFeedback(form, async () => {
          const feedback = actionFeedback("admin.toast.accessRemoved");
          try {
            if (form.dataset.membershipId)
              await removeProviderManagerAccess(
                adminApi,
                this.state.provider.providerId,
                form.dataset.membershipId,
              );
            else
              await revokeProviderDevices(
                adminApi,
                this.state.provider.providerId,
              );
            feedback.success();
            if (
              (await this.refreshProviderAccess(
                this.state.provider.providerId,
              )) === false
            )
              return;
          } catch (error) {
            feedback.failure(error);
            throw error;
          }
        });
        sync();
      });
    });
    this.querySelector("#admin-user-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = asForm(event.currentTarget);
        if (!form.reportValidity()) return;
        void withSaveFeedback(form, () => this.inviteAdministrator(form), {
          savingLabel: t("admin.users.sending"),
          onError: (error) =>
            showFormSaveError(form, adminInvitationError(error)),
        });
      },
    );
    this.querySelector("#admin-user-status-filter")?.addEventListener(
      "change",
      (event) => {
        this.state.adminUserStatusFilter = String(
          event.currentTarget.value || "all",
        );
        this.render();
      },
    );
    this.querySelector("#show-admin-role-help")?.addEventListener(
      "click",
      () => {
        this.querySelector("#admin-role-help-dialog")?.showModal();
      },
    );
    this.querySelectorAll("[data-admin-user-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const username = dataAttr(button, "data-username");
        const action = dataAttr(button, "data-admin-user-action");
        const requests = {
          suspend: () => adminApi.suspendAdminUser(username),
          reinstate: () => adminApi.reinstateAdminUser(username),
          reinvite: () => adminApi.reinviteAdminUser(username),
          reset: () => adminApi.resetAdminUserPassword(username),
        };
        const feedback = actionFeedback(
          {
            suspend: "admin.toast.adminSuspended",
            reinstate: "admin.toast.adminReinstated",
            reinvite: "admin.toast.invitationSent",
            reset: "admin.toast.passwordReset",
          }[action],
        );
        const request = requests[action]?.();
        if (!request) return;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = "Working…";
        request
          .then(() => {
            this.programManagersStale = true;
            feedback.success();
            this.state.adminUserMessage = "";
            return this.openRoute();
          })
          .catch((error) => {
            feedback.failure(error);
            this.state.error = error.message;
            this.render();
          });
      });
    });
    this.querySelectorAll("[data-admin-role]").forEach((select) => {
      select.addEventListener("change", () => {
        const feedback = actionFeedback("admin.toast.roleUpdated");
        adminApi
          .updateAdminUserRole(
            dataAttr(select, "data-username"),
            String(select.value),
          )
          .then(() => {
            feedback.success();
            return this.openRoute();
          })
          .catch((error) => {
            feedback.failure(error);
            this.state.error = error.message;
            this.render();
          });
      });
    });
    const profileForm = this.querySelector("#my-profile-form");
    if (profileForm) {
      const sync = () => syncDirtyForm(profileForm);
      syncDirtyForm(profileForm, true);
      profileForm.addEventListener("input", sync);
      profileForm.addEventListener("change", sync);
      profileForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (profileForm.dataset.saving === "true") return;
        const feedback = actionFeedback("admin.profile.saved");
        profileForm.dataset.saving = "true";
        const save = profileForm.querySelector("[data-save-button]");
        save.disabled = true;
        try {
          const data = new FormData(asForm(profileForm));
          const result = await adminApi.updateMyProfile({
            firstName: formValue(data, "firstName"),
            lastName: formValue(data, "lastName"),
            phoneExtension: formValue(data, "phoneExtension"),
            ...profilePhoneUpdate(
              formValue(data, "phone"),
              this.state.profile.phone,
            ),
          });
          feedback.success();
          this.state.profile = result.profile;
          const managerId = result.profile.directoryUserId;
          if (managerId) {
            const name = `${result.profile.firstName} ${result.profile.lastName}`;
            this.state.programManagers = this.state.programManagers.map(
              (manager) =>
                manager.userId === managerId
                  ? {
                      ...manager,
                      firstName: result.profile.firstName,
                      lastName: result.profile.lastName,
                      phone: result.profile.phone,
                      phoneExtension: result.profile.phoneExtension,
                      name,
                    }
                  : manager,
            );
            this.state.sites = this.state.sites.map((site) =>
              site.oversight?.cityProgramManagerId === managerId
                ? {
                    ...site,
                    oversight: { ...site.oversight, cityProgramManager: name },
                  }
                : site,
            );
          }
          this.state.profileMessage = "";
          if (profileForm.isConnected) {
            const draft = this.state.complianceProfileDraft;
            if (
              draft?.phase === "profile" &&
              result.profile.firstName?.trim() &&
              result.profile.lastName?.trim() &&
              result.profile.phone?.trim()
            ) {
              syncDirtyForm(profileForm, true);
              navigate(
                `/sites/${encodeURIComponent(draft.siteId)}?section=compliance`,
              );
            } else {
              this.render();
              this.querySelector("h1")?.focus();
            }
          }
        } catch (error) {
          feedback.failure(error);
          if (profileForm.isConnected)
            showFormSaveError(
              profileForm,
              t(
                error instanceof Error &&
                  error.message === "valid_phone_required"
                  ? "admin.profile.invalidPhone"
                  : "admin.profile.saveError",
              ),
            );
        } finally {
          delete profileForm.dataset.saving;
          if (profileForm.isConnected) sync();
        }
      });
    }
    this.bindAddressLookup();
    const searchInput = this.querySelector("#directory-search-input");
    if (searchInput) {
      let composing = false;
      const search = async () => {
        this.directorySearchDebounce?.cancel();
        if (composing || !searchInput.isConnected) return;
        const value = String(searchInput.value || "");
        const params = new URLSearchParams(location.search);
        if ((params.get("q") || "") === value.trim()) return;
        if (value.trim()) params.set("q", value.trim());
        else params.delete("q");
        const query = params.toString();
        history.replaceState(
          {},
          "",
          `${location.pathname}${query ? `?${query}` : ""}`,
        );
        // Filtering uses the already-loaded directory. Avoid a route change,
        // which would move focus to the heading or reload manager data.
        this.state.managerSearchFailed = false;
        this.renderDirectoryResults();
        if (value.trim()) void this.loadSearchManagers();
      };
      this.directorySearchDebounce = debounce(search, 300);
      searchInput.addEventListener("input", () => {
        if (!composing) this.directorySearchDebounce.schedule();
      });
      searchInput.addEventListener("compositionstart", () => {
        composing = true;
        this.directorySearchDebounce.cancel();
      });
      searchInput.addEventListener("compositionend", () => {
        composing = false;
        this.directorySearchDebounce.schedule();
      });
      this.querySelector("#directory-search")?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          search();
        },
      );
      this.querySelector("#clear-directory-search")?.addEventListener(
        "click",
        () => {
          searchInput.value = "";
          searchInput.focus();
          search();
        },
      );
    }
    this.bindDirectoryFilters();
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
      signOutAdmin();
    });
    this.querySelector("#provider-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = asForm(e.currentTarget);
      void this.saveWithFeedback(form, () => this.createProvider(form));
    });
    this.querySelector("#provider-details-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.updateProvider(asForm(event.currentTarget)).catch((error) => {
          this.state.error = error.message;
          this.render();
        });
      },
    );
    this.querySelector(
      "[data-assign-existing-provider-person]",
    )?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      void this.saveWithFeedback(form, async () => {
        const person = this.state.people.find(
          (p) => p.personId === controlValue(form, "person-id"),
        );
        if (!person) throw new Error(t("admin.relationships.choosePerson"));
        await adminApi.createProviderManager(
          this.state.provider.providerId,
          person,
        );
        if (
          (await this.refreshProviderAccess(this.state.provider.providerId)) ===
          false
        )
          return;
      });
    });
    this.querySelector("#add-provider-manager")?.addEventListener(
      "click",
      () => {
        this.querySelector("#add-provider-manager-dialog")?.showModal();
      },
    );
    this.querySelectorAll("[data-edit-provider-manager]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = button
          .closest("[data-provider-manager-row]")
          ?.querySelector("dialog");
        dialog?.showModal();
        dialog?.querySelector("wa-input")?.focus();
      });
    });
    this.querySelectorAll("[data-provider-manager-dialog]").forEach(
      (dialog) => {
        dialog.addEventListener("cancel", (event) => {
          if (dialog.querySelector("form")?.dataset.saving === "true") {
            event.preventDefault();
          }
        });
        dialog.addEventListener("close", () => {
          dialog.querySelector("form")?.reset();
          dialog.querySelector("[data-form-save-error]")?.remove();
        });
      },
    );
    this.querySelectorAll("[data-transfer-provider-manager]").forEach((form) =>
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.saveWithFeedback(form, async () => {
          const member = this.state.providerManagers.find(
            (m) => m.membershipId === form.dataset.transferProviderManager,
          );
          if (
            controlValue(form, "confirmation").trim().toLowerCase() !==
            member.email.toLowerCase()
          )
            throw new Error(t("admin.relationships.confirmationMismatch"));
          const { manager } = await adminApi.transferProviderManager(
            this.state.provider.providerId,
            member.membershipId,
            controlValue(form, "target-provider"),
          );
          form.dataset.isDirty = "false";
          navigate(
            providerManagerPath(manager.providerId, manager.membershipId),
          );
        });
      }),
    );
    this.querySelectorAll("[data-provider-manager-form]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submittedForm = asForm(event.currentTarget);
        await this.saveWithFeedback(submittedForm, () =>
          this.saveProviderManager(submittedForm),
        );
      });
    });
    this.querySelectorAll("[data-provider-manager-status]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          this.setProviderManagerActive(
            dataAttr(button, "data-provider-manager-status"),
            dataAttr(button, "data-provider-manager-active") === "true",
          ).catch((error) => {
            this.state.error = error.message;
            this.render();
          });
        });
      },
    );
    this.querySelectorAll("[data-issue-provider-manager-grant]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          this.issueProviderManagerGrant(
            dataAttr(button, "data-issue-provider-manager-grant"),
            button.dataset.deliveryMode || "link",
          ).catch((error) => {
            this.state.error = error.message;
            this.render();
          });
        });
      },
    );
    this.querySelectorAll("[data-cancel-provider-manager-grant]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          this.cancelProviderManagerGrant(
            dataAttr(button, "data-cancel-provider-manager-grant"),
          ).catch((error) => {
            this.state.error = error.message;
            this.render();
          });
        });
      },
    );
    this.querySelectorAll("[data-revoke-provider-enrollment]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          this.revokeProviderManagerEnrollment(
            dataAttr(button, "data-revoke-provider-enrollment"),
          ).catch((error) => {
            this.state.error = error.message;
            this.render();
          });
        });
      },
    );
    this.querySelector("#provider-program-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.addProgramToProvider(asForm(event.currentTarget)).catch(
          (error) => {
            this.state.error =
              error.message === "program_has_sites"
                ? "This Program has active Sites. Reassign those Sites before moving the Program to another provider."
                : error.message;
            this.render();
          },
        );
      },
    );
    const providerProgramForm = this.querySelector("#provider-program-form");
    if (providerProgramForm instanceof HTMLFormElement) {
      const programSelect = providerProgramForm.querySelector(
        "wa-select[name='program-id']",
      );
      const addProgramButton = providerProgramForm.querySelector(
        "[data-add-program-button]",
      );
      const syncAddProgramButton = () => {
        if (addProgramButton instanceof HTMLButtonElement) {
          addProgramButton.disabled = !String(
            programSelect?.value || "",
          ).trim();
        }
      };
      syncAddProgramButton();
      programSelect?.addEventListener("change", syncAddProgramButton);
      programSelect?.addEventListener("input", syncAddProgramButton);
    }
    bindNewProgramStaff(this, this.state.programs, adminApi);
    this.querySelector("#program-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const form = asForm(e.currentTarget);
      void this.saveWithFeedback(form, () => this.createProgram(form));
    });
    this.querySelector("#add-program-staff")?.addEventListener("click", () =>
      this.querySelector("#add-program-staff-dialog")?.showModal(),
    );
    this.querySelector("#cancel-program-staff")?.addEventListener("click", () =>
      this.querySelector("#add-program-staff-dialog")?.close(),
    );
    this.querySelector("#program-staff-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.addProgramStaff(asForm(event.currentTarget)).catch((error) => {
          this.state.error = error.message;
          this.render();
        });
      },
    );
    this.querySelectorAll("[data-edit-program-staff]").forEach((button) => {
      button.addEventListener("click", () =>
        this.querySelector(
          `#edit-program-staff-${CSS.escape(button.dataset.editProgramStaff)}`,
        )?.showModal(),
      );
    });
    this.querySelectorAll("[data-cancel-program-staff-edit]").forEach(
      (button) => {
        button.addEventListener("click", () =>
          button.closest("dialog")?.close(),
        );
      },
    );
    this.querySelectorAll("[data-program-staff-edit-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.saveProgramStaff(asForm(form));
      });
    });
    this.querySelector("#new-site-provider-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const providerId = formValue(
          new FormData(asForm(event.currentTarget)),
          "provider-id",
        );
        if (providerId)
          navigate(`/sites/new?providerId=${encodeURIComponent(providerId)}`);
      },
    );
    this.querySelector("#new-site-program-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const data = new FormData(asForm(event.currentTarget));
        navigate(
          `/sites/new?providerId=${encodeURIComponent(formValue(data, "provider-id"))}&programId=${encodeURIComponent(formValue(data, "program-id"))}`,
        );
      },
    );
    this.querySelector("#new-site-record-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = asForm(event.currentTarget);
        void withSaveFeedback(form, () => this.createSiteFromFlow(form), {
          savingLabel: t("siteAdmin.edit.saving"),
          onError: (error) => {
            if (form.isConnected)
              showFormSaveError(form, siteSaveErrorMessage(error));
          },
        });
      },
    );
    this.querySelector("#site-manager-record-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = asForm(event.currentTarget);
        const programId = formValue(new FormData(form), "manager-program-id");
        if (
          this.state.siteManager &&
          this.state.siteManager.programId !== programId
        ) {
          this.querySelector("#manager-program-change-dialog")?.showModal();
          return;
        }
        this.saveSiteManager(form);
      },
    );
    const managerProgramChangeDialog = this.querySelector(
      "#manager-program-change-dialog",
    );
    managerProgramChangeDialog?.addEventListener("close", () => {
      if (managerProgramChangeDialog.returnValue !== "confirm") return;
      const form = this.querySelector("#site-manager-record-form");
      if (form instanceof HTMLFormElement && form.reportValidity()) {
        this.saveSiteManager(form);
      }
    });
    this.querySelector("[data-remove-site-manager]")?.addEventListener(
      "click",
      () => {
        this.querySelector("#remove-site-manager-dialog")?.showModal();
      },
    );
    const removeSiteManagerDialog = this.querySelector(
      "#remove-site-manager-dialog",
    );
    removeSiteManagerDialog?.addEventListener("close", () => {
      if (removeSiteManagerDialog.returnValue !== "confirm") return;
      this.removeSiteManager();
    });
    this.querySelector(
      "wa-select[name='manager-program-id']",
    )?.addEventListener("change", (event) => {
      syncDirtyForm(this.querySelector("#site-manager-record-form"));
    });
    this.querySelectorAll(".new-record-form [required]").forEach((control) => {
      const sync = () => {
        control.toggleAttribute(
          "data-empty",
          !String(control.value || "").trim(),
        );
      };
      sync();
      control.addEventListener("input", sync);
      control.addEventListener("change", sync);
    });
    const siteDetailsForm = this.querySelector("#site-details-form");
    siteDetailsForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = asForm(event.currentTarget);
      if (
        !reportNamedControlsValidity(form, [
          "site-name",
          "public-contact-email",
          "public-contact-phone",
          "public-contact-extension",
        ])
      )
        return;
      this.updateSite(form, "details").catch((error) => {
        this.state.error = error.message;
        this.render();
      });
    });
    this.querySelector("[data-save-address]")?.addEventListener("click", () => {
      if (
        !(siteDetailsForm instanceof HTMLFormElement) ||
        !reportNamedControlsValidity(siteDetailsForm, [
          "street-address",
          "city",
          "state",
          "zip",
        ])
      )
        return;
      this.updateSite(siteDetailsForm, "address").catch((error) => {
        this.state.error = error.message;
        this.render();
      });
    });
    this.querySelector("[data-save-lead-program]")?.addEventListener(
      "click",
      async () => {
        if (
          !reportNamedControlsValidity(siteDetailsForm, [
            "lead-program-id",
            "lead-provider-id",
          ])
        )
          return;
        try {
          const { preview } = await adminApi.reassignSite(
            this.state.site.siteId,
            controlValue(siteDetailsForm, "lead-provider-id"),
            controlValue(siteDetailsForm, "lead-program-id"),
            { preview: true },
          );
          siteDetailsForm.dataset.reassignmentVersion = preview.updatedAt || "";
          const dialog = this.querySelector(
            "#lead-program-confirmation-dialog",
          );
          dialog.querySelector("[data-reassignment-preview]").textContent = t(
            "admin.relationships.impact",
            {
              previousProvider: preview.previousProvider,
              provider: preview.newProvider,
              previousProgram: preview.previousProgram,
              program: preview.newProgram,
              managers:
                preview.retainedManagers.join(", ") ||
                t("admin.relationships.none"),
              count: preview.affectedProviderDevices,
            },
          );
          dialog.showModal();
        } catch (error) {
          showFormSaveError(siteDetailsForm, error.message);
        }
      },
    );
    const leadProgramDialog = this.querySelector(
      "#lead-program-confirmation-dialog",
    );
    leadProgramDialog?.addEventListener("close", () => {
      if (
        leadProgramDialog.returnValue !== "confirm" ||
        !(siteDetailsForm instanceof HTMLFormElement) ||
        !reportNamedControlsValidity(siteDetailsForm, ["lead-program-id"])
      )
        return;
      this.updateSite(siteDetailsForm, "lead-program").catch((error) => {
        this.state.error = error.message;
        this.render();
      });
    });
    this.querySelector("#site-oversight-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.updateOversight(asForm(e.currentTarget));
      },
    );
    this.querySelector("#add-compliance-manager")?.addEventListener(
      "click",
      () => {
        const dialog = this.querySelector("#choose-compliance-manager-dialog");
        const search = /** @type {(HTMLElement & { value: string }) | null} */ (
          dialog?.querySelector("#compliance-manager-search") || null
        );
        if (search) search.value = "";
        dialog
          ?.querySelectorAll("[data-select-compliance-manager]")
          .forEach((button) => {
            button.closest("li").hidden = true;
          });
        const resultsHeading = dialog?.querySelector(
          "[data-manager-results-heading]",
        );
        if (resultsHeading) resultsHeading.hidden = true;
        const status = dialog?.querySelector("[data-manager-search-status]");
        if (status)
          status.textContent =
            "Search by name, email, or department to find a program manager.";
        dialog?.showModal();
        search?.focus();
      },
    );
    this.bindComplianceManagerAssignmentControls();
    this.updateComplianceManagerCount();
    this.querySelector("#invite-new-compliance-manager")?.addEventListener(
      "click",
      () => {
        this.querySelector("#choose-compliance-manager-dialog")?.close();
        const dialog = this.querySelector("#new-city-program-manager-dialog");
        dialog?.showModal();
        dialog?.querySelector("wa-input")?.focus();
      },
    );
    this.querySelectorAll("[data-select-compliance-manager]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          const manager = this.state.programManagers.find(
            (item) => item.userId === button.dataset.managerId,
          );
          if (!manager) return;
          this.addComplianceManagerAssignment(manager);
          this.querySelector("#choose-compliance-manager-dialog")?.close();
        });
      },
    );
    this.querySelector("#compliance-manager-search")?.addEventListener(
      "input",
      (event) => {
        const query = String(event.currentTarget.value || "")
          .trim()
          .toLocaleLowerCase("en-US");
        let visible = 0;
        this.querySelectorAll("[data-select-compliance-manager]").forEach(
          (button) => {
            const matches =
              Boolean(query) &&
              String(button.dataset.searchText || "").includes(query);
            button.closest("li").hidden = !matches;
            if (matches) visible += 1;
          },
        );
        const resultsHeading = this.querySelector(
          "[data-manager-results-heading]",
        );
        if (resultsHeading) resultsHeading.hidden = !query;
        const status = this.querySelector("[data-manager-search-status]");
        if (status) {
          status.textContent = !query
            ? "Search by name, email, or department to find a program manager."
            : visible
              ? `${visible} program manager${visible === 1 ? "" : "s"} found.`
              : "No matching program managers. You can invite a new one.";
        }
      },
    );
    this.querySelectorAll(
      "#site-oversight-form wa-select, #new-city-program-manager-form wa-select[name=manager-department]",
    ).forEach((select) => {
      select.addEventListener("change", async () => {
        const oversightForm = select.closest("form");
        const value =
          oversightForm instanceof HTMLFormElement
            ? controlValue(oversightForm, select.name)
            : String(select.value || "");
        if (!value.startsWith("__add_")) {
          select.dataset.previousValue = value;
          return;
        }
        const dialogId = {
          __add_department__: "#new-oversight-option-dialog",
          __add_system__: "#new-oversight-option-dialog",
        }[value];
        const dialog = this.querySelector(dialogId);
        if (!dialog) return;
        const form = dialog.querySelector("form");
        const type =
          value === "__add_department__" ? "department" : "systemOfCare";
        const label =
          type === "department" ? "City department" : "System of care";
        form.dataset.targetSelect = select.name;
        form.querySelector("[name='option-type']").value = type;
        form.querySelector("[data-option-title]").textContent =
          `Add a new ${label.toLowerCase()}`;
        form
          .querySelector("[data-option-input]")
          ?.setAttribute("label", `${label} name`);
        setSelectValue(select, select.dataset.previousValue || "");
        dialog.showModal();
        dialog.querySelector("wa-input")?.focus();
      });
      select.addEventListener("wa-show", () => {
        const oversightForm = select.closest("form");
        const current =
          oversightForm instanceof HTMLFormElement
            ? controlValue(oversightForm, select.name)
            : String(select.value || "");
        if (!current.startsWith("__add_"))
          select.dataset.previousValue = current;
      });
      select.addEventListener("focus", () => {
        const oversightForm = select.closest("form");
        const current =
          oversightForm instanceof HTMLFormElement
            ? controlValue(oversightForm, select.name)
            : String(select.value || "");
        if (!current.startsWith("__add_"))
          select.dataset.previousValue = current;
      });
    });
    this.querySelector("#new-city-program-manager-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.createCityProgramManager(asForm(event.currentTarget)).catch(
          (error) =>
            showFormSaveError(asForm(event.currentTarget), error.message),
        );
      },
    );
    this.querySelector("#new-oversight-option-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.createOversightOption(asForm(event.currentTarget)).catch((error) =>
          showFormSaveError(asForm(event.currentTarget), error.message),
        );
      },
    );
    this.querySelectorAll("[data-compliance-reason]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = this.querySelector("#compliance-reasons-dialog");
        dialog?.showModal();
      });
    });
    const reasonsDialog = this.querySelector("#compliance-reasons-dialog");
    const outsideReasonsDialog = (event) => {
      if (!reasonsDialog || event.target !== reasonsDialog) return false;
      const bounds = reasonsDialog.getBoundingClientRect();
      return (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      );
    };
    let reasonsBackdropPressed = false;
    reasonsDialog?.addEventListener("pointerdown", (event) => {
      reasonsBackdropPressed = outsideReasonsDialog(event);
    });
    reasonsDialog?.addEventListener("click", (event) => {
      if (reasonsBackdropPressed && outsideReasonsDialog(event))
        reasonsDialog.close();
      reasonsBackdropPressed = false;
    });
    this.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
    this.querySelectorAll(
      "#admin-user-form, #site-oversight-form, #site-compliance-form, #site-perimeter-form, #site-manager-record-form, #provider-manager-record-form",
    ).forEach((form) => {
      const sync = () => syncDirtyForm(form);
      syncDirtyForm(form, true);
      form.addEventListener("input", sync);
      form.addEventListener("change", sync);
      form.addEventListener("reset", () => queueMicrotask(sync));
    });
    const providerDetailsForm = this.querySelector("#provider-details-form");
    if (providerDetailsForm instanceof HTMLFormElement) {
      const sync = () => syncProviderDetailsForm(providerDetailsForm);
      sync();
      providerDetailsForm.addEventListener("input", sync);
      providerDetailsForm.addEventListener("change", sync);
      providerDetailsForm.addEventListener("reset", () => queueMicrotask(sync));
    }
    if (siteDetailsForm instanceof HTMLFormElement) {
      const sync = (event) => {
        markSiteDetailsSectionEdited(siteDetailsForm, event);
        syncSiteDetailsForm(siteDetailsForm);
      };
      syncSiteDetailsForm(siteDetailsForm, true);
      siteDetailsForm.addEventListener("pointerdown", sync, true);
      siteDetailsForm.addEventListener("keydown", sync, true);
      siteDetailsForm.addEventListener("input", sync);
      siteDetailsForm.addEventListener("change", sync);
      siteDetailsForm.addEventListener("reset", () => queueMicrotask(sync));
    }
    bindSiteProgramCreation(
      this,
      this.state,
      adminApi,
      (form, save) => this.saveWithFeedback(form, save),
      () => {
        if (siteDetailsForm instanceof HTMLFormElement)
          syncSiteDetailsForm(siteDetailsForm);
      },
      actionFeedback,
    );
    this.querySelector(
      "wa-select[name='site-manager-user-id']",
    )?.addEventListener("change", (event) => {
      const user = this.state.availableSiteUsers.find(
        (item) => item.userId === event.currentTarget.value,
      );
      const target = this.querySelector("#site-manager-contact-details");
      if (target) target.innerHTML = siteManagerContactDetails(user);
      if (siteDetailsForm instanceof HTMLFormElement)
        syncSiteDetailsForm(siteDetailsForm);
    });
    const leaveDialog = this.querySelector("#site-unsaved-dialog");
    leaveDialog?.addEventListener("close", () => {
      if (leaveDialog.returnValue === "discard") {
        const destination = this.pendingSiteDestination;
        if (destination) {
          this.lastRenderedPath = "";
          navigate(destination);
        }
      }
    });
    this.querySelector("[data-site-terms]")?.addEventListener(
      "toggle",
      (event) => {
        if (!event.currentTarget.isConnected) return;
        this.state.expandedTermsSiteId = event.currentTarget.open
          ? this.state.site.siteId
          : null;
      },
    );
    this.bindLetterActions();
    this.querySelectorAll("#site-terms-form, #site-compliance-form").forEach(
      (form) =>
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const currentForm = asForm(e.currentTarget);
          const validationError = compliancePeriodValidationError(currentForm);
          if (validationError) {
            return;
          }
          const saveButton = /** @type {HTMLButtonElement | null} */ (
            currentForm.querySelector("[data-save-button]")
          );
          if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = "Saving…";
          }
          try {
            await this.createSiteTerms(currentForm);
          } catch (err) {
            const errorMessage = showFormSaveError(
              currentForm,
              compliancePeriodErrorMessage(err),
            );
            if (
              err instanceof Error &&
              err.message === "generator_contact_required"
            ) {
              const [before, after] = t(
                "admin.compliance.generatorContactRequired",
                { profile: "{profile}" },
              ).split("{profile}");
              const profileLink = document.createElement("a");
              profileLink.href = "/profile";
              profileLink.textContent = t("admin.profile.title");
              profileLink.addEventListener("click", (event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                this.state.complianceProfileDraft = captureComplianceDraft(
                  currentForm,
                  this.state.site.siteId,
                );
                navigate("/profile");
              });
              errorMessage.replaceChildren(before, profileLink, after || "");
            }
            if (saveButton) {
              saveButton.disabled = false;
              saveButton.textContent = t("admin.letters.saveSend");
            }
          }
        }),
    );

    const newPeriodDialog = this.querySelector("#new-checks-period-dialog");
    const endPeriodDialog = this.querySelector("#end-checks-period-dialog");
    const requiredChecks = /** @type {{ value?: string } | null} */ (
      this.querySelector("wa-number-input[name='terms-checks-per-day']")
    );
    if (requiredChecks && !requiredChecks.value) requiredChecks.value = "3";
    this.querySelector("[data-require-checks]")?.addEventListener(
      "click",
      () => {
        newPeriodDialog?.showModal();
        newPeriodDialog?.querySelector("wa-checkbox")?.focus();
      },
    );
    this.querySelector("[data-end-checks]")?.addEventListener("click", () => {
      endPeriodDialog.returnValue = "";
      endPeriodDialog.showModal();
      endPeriodDialog.querySelector('[value="cancel"]')?.focus();
    });
    const syncPeriodFields = () => {
      const form = this.querySelector("#site-compliance-form");
      const selected = [
        ...this.querySelectorAll("wa-checkbox[name='terms-reason']"),
      ]
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value);
      const expiry = this.querySelector("[data-expiry-field]");
      const needsExpiry = selected.some((reason) =>
        ["1", "6"].includes(reason),
      );
      expiry?.toggleAttribute("hidden", !needsExpiry);
      expiry?.toggleAttribute("required", needsExpiry);
      if (form instanceof HTMLFormElement) {
        const saveButton = /** @type {HTMLButtonElement | null} */ (
          form.querySelector("[data-save-button]")
        );
        if (saveButton) {
          saveButton.disabled = Boolean(compliancePeriodValidationError(form));
        }
        const error = /** @type {HTMLElement | null} */ (
          form.querySelector("[data-form-save-error]")
        );
        if (error) {
          error.textContent = "";
          error.hidden = true;
        }
      }
    };
    this.querySelectorAll("wa-checkbox[name='terms-reason']").forEach(
      (checkbox) => checkbox.addEventListener("change", syncPeriodFields),
    );
    this.querySelector("#site-compliance-form")?.addEventListener(
      "input",
      syncPeriodFields,
    );
    this.querySelector("#site-compliance-form")?.addEventListener(
      "change",
      syncPeriodFields,
    );
    this.querySelector("#retry-compliance-draft")?.addEventListener(
      "click",
      () => {
        const draft = this.state.complianceProfileDraft;
        if (!draft) return;
        draft.phase = "returning";
        this.state.error = "";
        navigate(
          `/sites/${encodeURIComponent(draft.siteId)}?section=compliance`,
        );
      },
    );
    syncPeriodFields();
    const draft = this.state.complianceProfileDraft;
    if (
      draft?.phase === "returning" &&
      this.state.site?.siteId === draft.siteId &&
      new URLSearchParams(window.location.search).get("section") ===
        "compliance"
    ) {
      const form = this.querySelector("#site-compliance-form");
      if (form instanceof HTMLFormElement && newPeriodDialog) {
        restoreComplianceDraft(form, draft);
        // Web Awesome controls finish their internal render asynchronously.
        requestAnimationFrame(() => {
          if (
            !newPeriodDialog.isConnected ||
            this.state.complianceProfileDraft !== draft
          )
            return;
          try {
            newPeriodDialog.showModal();
            newPeriodDialog.querySelector("wa-checkbox")?.focus();
            this.state.complianceProfileDraft = null;
          } catch {
            draft.phase = "recovery";
            this.render();
          }
        });
      } else {
        draft.phase = "recovery";
        queueMicrotask(() => this.render());
      }
    }
    this.querySelector("[data-cancel-checks-period]")?.addEventListener(
      "click",
      () => {
        newPeriodDialog?.close();
      },
    );
    endPeriodDialog?.addEventListener("close", () => {
      if (endPeriodDialog.returnValue === "confirm") {
        this.endSiteTerms().catch((error) => {
          this.state.error = error.message;
          this.render();
        });
      }
    });
    this.querySelector("#site-perimeter-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.updatePerimeter(asForm(e.currentTarget));
      },
    );
    this.querySelector("#reload-site-perimeter")?.addEventListener(
      "click",
      () => {
        if (this.state.site) this.openSite(this.state.site.siteId, false);
      },
    );
    this.querySelector("#site-import-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.previewSiteImport(asForm(e.currentTarget)).catch((err) => {
        this.state.importBusy = false;
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector('input[name="site-import-file"]')?.addEventListener(
      "change",
      (event) => {
        const input = /** @type {HTMLInputElement} */ (event.currentTarget);
        const fileName = this.querySelector("#site-import-file-name");
        if (!fileName) return;
        fileName.textContent = input.files?.[0]?.name || "";
        fileName.toggleAttribute("hidden", !input.files?.length);
      },
    );
    this.querySelector("#apply-site-import")?.addEventListener("click", () => {
      this.applySiteImport().catch((err) => {
        this.state.importBusy = false;
        this.state.importNotice = null;
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector("#dismiss-import-notice")?.addEventListener(
      "click",
      () => {
        this.state.importNotice = null;
        this.render();
      },
    );
    this.querySelector("#cancel-site-import")?.addEventListener("click", () => {
      this.cancelSiteImport();
    });
    this.querySelector("#show-import-help")?.addEventListener("click", () => {
      this.querySelector("#site-import-help-dialog")?.showModal();
    });
    this.querySelector("#download-import-conflicts")?.addEventListener(
      "click",
      () => {
        this.downloadImportConflicts().catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelector("#site-details-form")?.addEventListener("input", () => {
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      this.querySelector("#site-save-status")?.remove();
      this.querySelector("#site-save-error")?.remove();
    });
    this.querySelector("#manager-membership-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.addManagerMembership(asForm(e.currentTarget)).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    const managerMembershipForm = this.querySelector(
      "#manager-membership-form",
    );
    const managerMembershipSelect = managerMembershipForm?.querySelector(
      "wa-select[name='manager-user-id']",
    );
    const managerMembershipActions = managerMembershipForm?.querySelector(
      "[data-manager-membership-actions]",
    );
    const syncManagerMembershipSubmit = () => {
      const selectedUserId = String(managerMembershipSelect?.value || "");
      const selectedUser = this.state.availableSiteUsers.find(
        (user) => user.userId === selectedUserId,
      );
      const isCurrentManager = this.state.managerMemberships.some(
        (membership) =>
          membership.userId === selectedUserId ||
          (!membership.userId &&
            String(membership.email || "").toLowerCase() ===
              String(selectedUser?.email || "").toLowerCase()),
      );
      managerMembershipActions?.toggleAttribute(
        "hidden",
        !selectedUser || isCurrentManager,
      );
    };
    managerMembershipSelect?.addEventListener("change", () => {
      if (managerMembershipSelect.value !== "__create_site_manager__") return;
      managerMembershipSelect.value = "";
      this.querySelector("#new-site-manager-dialog")?.showModal();
    });
    this.querySelector("#new-site-manager-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.createSiteManagerFromAccess(asForm(event.currentTarget));
      },
    );
    const newManagerDialog = this.querySelector("#new-site-manager-dialog");
    this.querySelector("[data-cancel-new-site-manager]")?.addEventListener(
      "click",
      () => newManagerDialog?.close(),
    );
    newManagerDialog?.addEventListener("cancel", (event) => {
      if (newManagerDialog.querySelector("form")?.dataset.saving)
        event.preventDefault();
    });
    newManagerDialog?.addEventListener("close", () => {
      const form = newManagerDialog.querySelector("form");
      form?.reset();
      if (form) {
        delete form.dataset.createdUser;
        delete form.dataset.saving;
      }
      form?.querySelectorAll("wa-input").forEach((input) => {
        input.disabled = false;
      });
      form?.querySelector("[data-form-save-error]")?.remove();
      managerMembershipSelect?.focus();
    });
    managerMembershipForm
      ?.querySelector("[data-cancel-manager-assignment]")
      ?.addEventListener("click", () => {
        managerMembershipSelect.value = "";
        syncManagerMembershipSubmit();
        managerMembershipSelect.focus();
      });
    syncManagerMembershipSubmit();
    managerMembershipSelect?.addEventListener(
      "change",
      syncManagerMembershipSubmit,
    );
    this.querySelector("#setup-code-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.issueSetupCode(asForm(e.currentTarget));
    });
    this.querySelectorAll("[data-provider]").forEach((button) => {
      button.addEventListener("click", () =>
        this.openProvider(dataAttr(button, "data-provider")),
      );
    });
    this.querySelectorAll("[data-deactivate-provider]").forEach((button) => {
      button.addEventListener("click", () => {
        this.querySelector("#deactivate-provider-dialog")?.showModal();
      });
    });
    const deactivateProviderDialog = this.querySelector(
      "#deactivate-provider-dialog",
    );
    deactivateProviderDialog?.addEventListener("close", () => {
      if (deactivateProviderDialog.returnValue !== "confirm") return;
      const button = this.querySelector("[data-deactivate-provider]");
      if (!button) return;
      this.deactivateProvider(
        dataAttr(button, "data-deactivate-provider"),
      ).catch((error) => {
        this.state.error =
          error instanceof Error
            ? error.message
            : "The provider could not be deactivated.";
        this.render();
      });
    });
    this.querySelectorAll("[data-site]").forEach((button) => {
      button.addEventListener("click", () =>
        this.openSite(dataAttr(button, "data-site")),
      );
    });
    const deactivateForm = this.querySelector("#deactivate-site-form");
    const deactivateConfirmation = deactivateForm?.querySelector(
      "[name='confirmation']",
    );
    const deactivateSubmit = deactivateForm?.querySelector(
      "button[type='submit']",
    );
    const confirmedSiteName = () =>
      Boolean(this.state.site?.name) &&
      String(deactivateConfirmation?.value || "") === this.state.site.name;
    const syncDeactivateSubmit = () => {
      if (deactivateSubmit)
        deactivateSubmit.disabled =
          deactivateForm.dataset.saving === "true" || !confirmedSiteName();
    };
    deactivateConfirmation?.addEventListener("input", syncDeactivateSubmit);
    deactivateConfirmation?.addEventListener("change", syncDeactivateSubmit);
    syncDeactivateSubmit();
    deactivateForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (
        !this.state.capabilities.createEntities ||
        !confirmedSiteName() ||
        deactivateForm.dataset.saving === "true"
      )
        return;
      deactivateForm.dataset.saving = "true";
      syncDeactivateSubmit();
      try {
        await this.deactivateSite(this.state.site.siteId);
      } catch {
        if (deactivateForm.isConnected)
          showFormSaveError(deactivateForm, t("admin.site.deactivateError"));
      } finally {
        delete deactivateForm.dataset.saving;
        if (deactivateForm.isConnected) syncDeactivateSubmit();
      }
    });
    this.querySelectorAll("[data-remove-manager-membership]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          this.openManagerMembershipRemoval(
            dataAttr(button, "data-remove-manager-membership"),
          );
        });
      },
    );
    const removeManagerMembershipDialog = this.querySelector(
      "#remove-manager-membership-dialog",
    );
    removeManagerMembershipDialog?.addEventListener("close", () => {
      const target = this.state.managerMembershipRemovalTarget;
      this.state.managerMembershipRemovalTarget = null;
      if (
        removeManagerMembershipDialog.returnValue !== "confirm" ||
        !target?.membershipId
      ) {
        return;
      }
      this.deactivateManagerMembership(target.membershipId).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelectorAll("[data-issue-manager-grant]").forEach((button) => {
      button.addEventListener("click", () =>
        this.issueManagerGrant(
          dataAttr(button, "data-issue-manager-grant"),
          button.dataset.deliveryMode || "link",
        ).catch(() => {
          // issueManagerGrant already reports the failure through its toast.
        }),
      );
    });
    this.querySelectorAll("[data-cancel-manager-grant]").forEach((button) => {
      button.addEventListener("click", () =>
        this.cancelManagerGrant(
          dataAttr(button, "data-cancel-manager-grant"),
        ).catch((err) => {
          this.state.error = err.message;
          this.render();
        }),
      );
    });
    this.querySelectorAll("[data-copy-enrollment-url]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button instanceof HTMLButtonElement) {
          void this.copyManagerGrant(button);
        }
      });
    });
    this.querySelectorAll("[data-issue-contact-code]").forEach((button) => {
      button.addEventListener("click", () =>
        this.issueSetupCodeForEmail(
          dataAttr(button, "data-issue-contact-code"),
        ),
      );
    });
    this.querySelectorAll("[data-revoke-device]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await this.revokeDevice(button.dataset.revokeDevice);
        } catch (err) {
          this.state.error = err.message;
          this.render();
        } finally {
          button.disabled = false;
        }
      });
    });
    const revokeAllForm = this.querySelector("#revoke-all-site-devices");
    if (revokeAllForm) {
      const input = revokeAllForm.querySelector("wa-input");
      const button = revokeAllForm.querySelector("button");
      let pending = false;
      const sync = () => {
        button.disabled =
          pending ||
          !canEditSite(this.state) ||
          input.value !== this.state.site?.name;
      };
      sync();
      input.addEventListener("input", sync);
      revokeAllForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        sync();
        if (button.disabled) return;
        pending = true;
        input.disabled = true;
        sync();
        try {
          await this.revokeAllSiteDevices(revokeAllForm);
        } catch (err) {
          this.state.error = err.message;
          this.render();
        } finally {
          pending = false;
          input.disabled = !canEditSite(this.state);
          sync();
        }
      });
    }
    const revokeManagerForm = this.querySelector("#revoke-manager-devices");
    if (revokeManagerForm) {
      const input = revokeManagerForm.querySelector("wa-input");
      const button = revokeManagerForm.querySelector("button");
      const sync = () => {
        button.disabled =
          input.value.trim().toLowerCase() !==
          this.state.siteManager.email.toLowerCase();
      };
      input.addEventListener("input", sync);
      revokeManagerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        input.disabled = true;
        const manager = this.state.siteManager;
        const status = revokeManagerForm.querySelector(
          "[data-revocation-status]",
        );
        try {
          const result = manager.personId
            ? await adminApi.revokePersonDevices(manager.personId, input.value)
            : await adminApi.revokeManagerDevices(
                manager.programId,
                manager.userId,
                input.value,
              );
          status.textContent = t("admin.devices.managerRevoked", {
            count: result.affectedCount,
          });
          this.state.managerDirectoryLoaded = false;
          this.managerDirectoryVersion =
            (this.managerDirectoryVersion || 0) + 1;
          input.value = "";
        } catch {
          status.textContent = t("admin.devices.managerRevokeFailed");
        } finally {
          input.disabled = false;
          sync();
        }
      });
    }
    this.querySelector("#physical-device-revocation")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.revokePhysicalDeviceEverywhere(event.currentTarget).catch(
          (err) => {
            this.state.error = err.message;
            this.render();
          },
        );
      },
    );
    this.querySelector("#cancel-physical-device-revocation")?.addEventListener(
      "click",
      () => {
        this.state.physicalDeviceRevocationPreview = null;
        this.render();
      },
    );
    this.querySelector("#begin-emergency-site-revocation")?.addEventListener(
      "click",
      () => {
        this.beginEmergencySiteRevocation().catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelector("#emergency-site-selection")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.previewEmergencySiteRevocation(event.currentTarget).catch(
          (err) => {
            this.state.error = err.message;
            this.render();
          },
        );
      },
    );
    this.querySelector("#emergency-site-confirmation")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.startEmergencySiteRevocation(event.currentTarget).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelectorAll("[data-cancel-emergency-revocation]").forEach(
      (button) => {
        button.addEventListener("click", () => {
          this.state.emergencyRevocationSites = [];
          this.state.emergencyRevocationPreview = null;
          this.render();
        });
      },
    );
  }

  bindAddressLookup() {
    this.querySelectorAll("[data-address-lookup]").forEach((lookup) => {
      const input = lookup.querySelector("[data-address-query]");
      const results = lookup.querySelector("[data-address-results]");
      const status = lookup.querySelector("[data-address-status]");
      const fields = lookup.parentElement?.querySelector(
        "[data-address-fields]",
      );
      const manualButton = lookup.querySelector(
        "[data-enter-address-manually]",
      );
      if (!input || !results || !status || !fields) return;
      let timer;
      let controller;

      const showFields = () => {
        fields.hidden = false;
        fields.setAttribute("data-expanded", "");
        manualButton?.setAttribute("aria-expanded", "true");
        if (manualButton) manualButton.textContent = "Hide manual entry";
        fields.querySelectorAll("wa-input").forEach((field) => {
          field.disabled = false;
        });
        input.removeAttribute("required");
        results.replaceChildren();
        input.setAttribute("aria-expanded", "false");
        const submit = lookup
          .closest("form")
          ?.querySelector("[data-address-dependent]");
        if (submit && !submit.hasAttribute("data-address-blocked")) {
          submit.disabled = false;
        }
      };
      const hideFields = () => {
        fields.hidden = true;
        fields.removeAttribute("data-expanded");
        manualButton?.setAttribute("aria-expanded", "false");
        if (manualButton) manualButton.textContent = "Enter address manually";
        results.replaceChildren();
        input.setAttribute("aria-expanded", "false");
        status.textContent = "Manual address fields hidden.";
      };
      const selectSuggestion = (suggestion) => {
        showFields();
        input.value = suggestion.label;
        const parts = suggestion.addressParts || {};
        const values = {
          "street-address": [parts.streetNumber, parts.streetAddress]
            .filter(Boolean)
            .join(" "),
          city: parts.city || "",
          state: parts.state || "",
          zip: parts.zip || "",
        };
        for (const [name, value] of Object.entries(values)) {
          const field = fields.querySelector(`[name='${name}']`);
          if (!field) continue;
          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }
        status.textContent = `${suggestion.label} selected. You can edit the address fields below.`;
        fields.querySelector("[name='street-address']")?.focus();
      };
      const renderSuggestions = (suggestions) => {
        results.replaceChildren();
        for (const suggestion of suggestions) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = suggestion.label;
          button.addEventListener("click", () => selectSuggestion(suggestion));
          item.append(button);
          results.append(item);
        }
        input.setAttribute(
          "aria-expanded",
          suggestions.length ? "true" : "false",
        );
        status.textContent = suggestions.length
          ? `${suggestions.length} address suggestion${suggestions.length === 1 ? "" : "s"} available.`
          : "No matching addresses found. You can enter the address manually.";
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        controller?.abort();
        const query = input.value.trim();
        if (query.length < 3) {
          results.replaceChildren();
          input.setAttribute("aria-expanded", "false");
          status.textContent =
            query.length > 0 ? "Type at least 3 characters." : "";
          return;
        }
        timer = setTimeout(async () => {
          controller = new AbortController();
          status.textContent = "Finding addresses…";
          try {
            const response = await adminApi.suggestAddresses(
              query,
              controller.signal,
            );
            if (query !== input.value.trim()) return;
            renderSuggestions(response.suggestions || []);
          } catch (error) {
            if (error.name === "AbortError") return;
            results.replaceChildren();
            input.setAttribute("aria-expanded", "false");
            status.textContent =
              "Address suggestions are unavailable. Enter the address manually.";
          }
        }, 300);
      });
      input.addEventListener("wa-clear", () => {
        results.replaceChildren();
        input.setAttribute("aria-expanded", "false");
        status.textContent = "";
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          const first = results.querySelector("button");
          if (first) {
            event.preventDefault();
            first.focus();
          }
        } else if (event.key === "Escape") {
          results.replaceChildren();
          input.setAttribute("aria-expanded", "false");
        }
      });
      manualButton?.addEventListener("click", () => {
        if (fields.hasAttribute("data-expanded")) {
          hideFields();
        } else {
          showFields();
          fields.querySelector("[name='street-address']")?.focus();
        }
      });
    });

    this.querySelectorAll("[data-edit-address]").forEach((button) => {
      const container = button.closest("[data-address-container]");
      const display = container?.querySelector("[data-address-display]");
      const editor = container?.querySelector("[data-address-editor]");
      const originalValues = new Map(
        [...(editor?.querySelectorAll("[name]") || [])].map((control) => [
          control,
          control.getAttribute("value") ?? String(control.value || ""),
        ]),
      );
      button.addEventListener("click", () => {
        if (!editor) return;
        const isEditing = !editor.hasAttribute("hidden");
        if (isEditing) {
          editor.setAttribute("hidden", "");
          display?.removeAttribute("hidden");
          button.textContent = "Edit address";
          button.setAttribute("aria-expanded", "false");
          for (const [control, value] of originalValues) control.value = value;
          const fields = editor.querySelector("[data-address-fields]");
          fields?.setAttribute("hidden", "");
          fields?.removeAttribute("data-expanded");
          fields?.querySelectorAll("wa-input").forEach((field) => {
            field.disabled = true;
          });
          const manualButton = editor.querySelector(
            "[data-enter-address-manually]",
          );
          if (manualButton) {
            manualButton.textContent = "Enter address manually";
            manualButton.setAttribute("aria-expanded", "false");
          }
          editor.querySelector("[data-address-results]")?.replaceChildren();
          const status = editor.querySelector("[data-address-status]");
          if (status) status.textContent = "";
          const form = button.closest("form");
          if (form instanceof HTMLFormElement) {
            const editedSections = new Set(
              JSON.parse(form.dataset.editedSections || "[]"),
            );
            editedSections.delete("address");
            form.dataset.editedSections = JSON.stringify([...editedSections]);
            syncSiteDetailsForm(form);
          }
          button.focus();
          return;
        }
        display?.setAttribute("hidden", "");
        editor.removeAttribute("hidden");
        button.textContent = "Cancel edit";
        button.setAttribute("aria-expanded", "true");
        editor.querySelector("[data-address-query]")?.focus();
      });
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
    const { provider, program, site, siteManager } = loading
      ? {}
      : visibleRecords(this.state, route);
    const requestedSection =
      new URLSearchParams(window.location.search).get("section") || "details";
    const siteSubview =
      new URLSearchParams(window.location.search).get("view") || "";
    const activeSiteSection =
      {
        staff: "details",
        terms: "compliance",
        letters: "compliance",
        perimeter: "compliance",
      }[requestedSection] || requestedSection;
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
                ${siteSectionNav(site.siteId, activeSiteSection)}
                ${siteSectionView(this.state, activeSiteSection, siteSubview)}
                ${discardChangesDialog()}
              </section>
            `
            : ""
        }
      </main>
    `;
    this.bind();
    this.applyCapabilities();
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
        "[data-require-checks], [data-end-checks], [data-resend-letter], [data-issue-manager-grant], [data-cancel-manager-grant], [data-revoke-device], [data-remove-manager-membership], [data-remove-site-manager], [data-edit-manager-membership]",
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

customElements.define("admin-app", AdminApp);

/** @param {AdminState} state */
function canEditSite(state) {
  return (
    state.capabilities.createEntities === true || state.siteCanEdit === true
  );
}

/** Shared staff changes require access to every assigned Site. @param {AdminState} state */
function canEditSiteManager(state) {
  if (state.capabilities.createEntities === true) return true;
  const assigned = state.siteManager?.assignedSites || [];
  const id = state.profile?.directoryUserId;
  return Boolean(
    id &&
      assigned.length &&
      assigned.every((site) =>
        state.sites.some(
          (item) =>
            item.siteId === site.siteId &&
            (item.complianceManagerIds || []).includes(id),
        ),
      ),
  );
}

/** @param {AdminState} state */
function myProfileView(state) {
  const profile = state.profile;
  if (!profile) return "";
  const sites = state.sites.filter(
    (site) =>
      site.status !== "inactive" &&
      (site.complianceManagerIds || []).includes(profile.directoryUserId),
  );
  return `<section class="site-page" aria-labelledby="profile-title">
    <a class="site-back-link" href="/sites" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.profile.back"))}</a>
    <h1 id="profile-title" tabindex="-1">${escapeHtml(t("admin.profile.title"))}</h1>
    <p>${escapeHtml(t(profile.role === "compliance-supervisor" ? "admin.profile.supervisor" : "admin.profile.manager"))}</p>
    <form id="my-profile-form" class="site-details-form" data-dirty-form>
      ${formInput("firstName", t("siteAdmin.field.firstName"), profile.firstName, { required: true, maxlength: 100, autocomplete: "given-name" })}
      ${formInput("lastName", t("siteAdmin.field.lastName"), profile.lastName, { required: true, maxlength: 100, autocomplete: "family-name" })}
      ${phoneInput("phone", t("siteAdmin.field.phone"), profile.phone, { extension: profile.phoneExtension, required: Boolean(profile.phone) || Boolean(state.complianceProfileDraft), type: "tel", autocomplete: "tel" })}
      <dl class="profile-email">
        <dt>${escapeHtml(t("siteAdmin.field.email"))}</dt>
        <dd>${escapeHtml(profile.email)}</dd>
      </dl>
      <button class="btn-primary" type="submit" data-save-button disabled>${escapeHtml(t("common.save"))}</button>
    </form>
    ${state.profileMessage ? `<p id="profile-message" class="success" role="status" tabindex="-1">${escapeHtml(state.profileMessage)}</p>` : ""}
    ${profile.role === "compliance-manager" ? `<section class="subsection"><h2>${escapeHtml(t("admin.profile.sites"))}</h2>${sites.length ? `<ul class="site-directory-list">${sites.map((site) => `<li><a class="site-directory-row" href="/sites/${encodeURIComponent(site.siteId)}" data-route>${escapeHtml(site.name || site.siteName || site.siteId)}</a></li>`).join("")}</ul>` : `<p class="empty-state">${escapeHtml(t("admin.profile.noSites"))}</p>`}</section>` : ""}
    ${discardChangesDialog()}
  </section>`;
}

function adminSettingsMenu(canManageUsers, canImportSites) {
  return `<div class="admin-settings-wrap">
    <button class="admin-settings" type="button" popovertarget="admin-settings-menu" aria-label="Settings" aria-haspopup="menu">
      <wa-icon name="gear" aria-hidden="true"></wa-icon>
    </button>
    <div class="admin-settings-menu" id="admin-settings-menu" popover role="menu" aria-label="Settings">
      <a href="/profile" data-route role="menuitem"><wa-icon name="user" aria-hidden="true"></wa-icon><span>${escapeHtml(t("admin.profile.title"))}</span></a>
      ${canManageUsers ? '<a href="/administrators" data-route role="menuitem"><wa-icon name="people-group" aria-hidden="true"></wa-icon><span>User management</span></a>' : ""}
      ${canImportSites ? '<a href="/sites/import" data-route role="menuitem"><wa-icon name="file-import" aria-hidden="true"></wa-icon><span>Import</span></a>' : ""}
      ${canManageUsers ? `<a href="/system-status" data-route role="menuitem"><wa-icon name="heart-pulse" aria-hidden="true"></wa-icon><span>${escapeHtml(t("admin.status.menu"))}</span></a>` : ""}
      <button id="clear-token" type="button" role="menuitem"><wa-icon name="arrow-right-from-bracket" aria-hidden="true"></wa-icon><span>Sign out</span></button>
    </div>
  </div>`;
}

function administratorView(users, state) {
  const statusFilter = state.adminUserStatusFilter || "all";
  const message = state.adminUserMessage || "";
  const directoryMode = state.adminUserDirectoryMode || "cognito";
  const filteredUsers = users.filter(
    (user) =>
      statusFilter === "all" || adminUserLifecycleStatus(user) === statusFilter,
  );
  return `<section class="panel" aria-labelledby="administrators-title">
    <a class="site-back-link" href="/sites" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div class="panel__head"><div><h1 id="administrators-title" tabindex="-1">Manage users</h1><p class="muted">Invite, suspend, reinstate, or manage user access.</p></div><button class="btn-primary" type="button" data-navigate="/administrators/new">${escapeHtml(t("admin.users.add"))}</button></div>
    ${directoryMode === "local" ? '<p class="admin-local-directory" role="note"><strong>Local test directory.</strong> Changes reset when the backend restarts, and no emails are sent.</p>' : ""}
    ${message ? `<p class="success admin-user-toast" role="status">${escapeHtml(message)}</p>` : ""}
    <div class="admin-user-filter">
      <wa-select id="admin-user-status-filter" label="Filter by status" value="${escapeHtml(statusFilter)}">
        <wa-option value="all">All statuses</wa-option>
        <wa-option value="active">Active</wa-option>
        <wa-option value="invited">Invited</wa-option>
        <wa-option value="suspended">Suspended</wa-option>
      </wa-select>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>
      ${filteredUsers.map(adminUserRow).join("")}
    </tbody></table></div>
    ${filteredUsers.length ? "" : '<p class="empty-state">No administrators match this status.</p>'}
    ${adminRoleHelpDialog()}
  </section>`;
}

function newAdministratorView(state) {
  const departments = uniqueNamedOptions(state.oversightOptions.departments);
  return `<section class="creation-page" aria-labelledby="new-admin-user-title">
    <a class="site-back-link btn-icon" href="/administrators" data-route aria-label="${escapeHtml(t("common.back"))}"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon></a>
    <h1 id="new-admin-user-title" tabindex="-1">${escapeHtml(t("admin.users.add"))}</h1>
    <p class="muted">${escapeHtml(t("admin.users.help"))}</p>
    <form id="admin-user-form" class="site-details-form" data-dirty-form>
      <fieldset><legend>${escapeHtml(t("admin.users.invite"))}</legend>
        <div class="form-grid">
          <wa-input name="firstName" label="${escapeHtml(t("admin.programs.firstName"))}" required></wa-input>
          <wa-input name="lastName" label="${escapeHtml(t("admin.programs.lastName"))}" required></wa-input>
          <wa-input name="email" type="email" label="${escapeHtml(t("admin.users.email"))}" autocomplete="email" required></wa-input>
          ${phoneInput("phone", t("siteAdmin.field.phone"), "", { required: true, type: "tel", autocomplete: "tel" })}
          <wa-select name="departmentId" label="${escapeHtml(t("admin.users.department"))}" placeholder="${escapeHtml(t("admin.users.chooseDepartment"))}">
            ${departments.map((item) => `<wa-option value="${escapeHtml(item.departmentId || item.name)}">${escapeHtml(item.name)}</wa-option>`).join("")}
          </wa-select>
          <div class="admin-role-label">
            <wa-select name="role" label="${escapeHtml(t("admin.users.role"))}" value="compliance-manager">
              <wa-option value="compliance-manager">${escapeHtml(t("admin.profile.manager"))}</wa-option>
              <wa-option value="compliance-supervisor">${escapeHtml(t("admin.profile.supervisor"))}</wa-option>
            </wa-select>
            <button class="btn-icon" id="show-admin-role-help" type="button" aria-label="${escapeHtml(t("admin.users.roleHelp"))}"><wa-icon name="circle-info" aria-hidden="true"></wa-icon></button>
          </div>
        </div>
        <div class="admin-invite-actions">
          <button class="btn-primary" type="submit">${escapeHtml(t("admin.users.send"))}</button>
          <button class="btn-secondary" type="button" data-save-cancel data-navigate="/administrators">${escapeHtml(t("common.cancel"))}</button>
        </div>
      </fieldset>
    </form>
    ${adminRoleHelpDialog()}
    ${discardChangesDialog()}
  </section>`;
}

function adminInvitationError(error) {
  const key = {
    valid_email_required: "admin.users.invalidEmail",
    name_required: "admin.users.nameRequired",
    valid_phone_required: "admin.profile.invalidPhone",
    invalid_role: "admin.users.invalidRole",
    admin_user_exists: "admin.users.exists",
    compliance_profile_conflict: "admin.users.profileConflict",
  }[error?.message];
  return t(key || "admin.users.failed");
}

function adminUserRow(user) {
  const status = adminUserLifecycleStatus(user);
  const statusLabel =
    { active: "Active", invited: "Invited", suspended: "Suspended" }[status] ||
    status;
  const username = escapeHtml(user.username);
  const actions =
    status === "suspended"
      ? `<button class="btn-secondary" type="button" data-admin-user-action="reinstate" data-username="${username}">Reinstate</button>`
      : `${
          status === "invited"
            ? `<button class="btn-secondary" type="button" data-admin-user-action="reinvite" data-username="${username}">Re-invite</button>`
            : user.canResetPassword
              ? `<button class="btn-secondary" type="button" data-admin-user-action="reset" data-username="${username}">Reset password</button>`
              : ""
        }<button class="btn-danger" type="button" data-admin-user-action="suspend" data-username="${username}">Suspend</button>`;
  return `<tr><td>${escapeHtml(user.name || "—")}</td><td>${escapeHtml(user.email)}</td><td class="admin-user-role"><wa-select aria-label="Role for ${escapeHtml(user.email)}" data-admin-role data-username="${username}" value="${escapeHtml(user.role)}"><wa-option value="compliance-manager">Manager</wa-option><wa-option value="compliance-supervisor">Supervisor</wa-option></wa-select></td><td>${escapeHtml(statusLabel)}</td><td><div class="admin-user-actions">${actions}</div></td></tr>`;
}

function adminRoleHelpDialog() {
  return `<dialog id="admin-role-help-dialog" class="places-modal" aria-labelledby="admin-role-help-title">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="admin-role-help-title">User roles</h2>
        <div class="admin-role-help-copy">
          <section>
            <h3>Manager</h3>
            <p>Managers can update existing providers, programs, sites, contacts, setup codes, and device access. They can generate compliance letters, enroll devices, and revoke device access.</p>
          </section>
          <section>
            <h3>Supervisor</h3>
            <p>Supervisors can do everything a Manager can. They can also manage users, create and deactivate records, run bulk imports, and change a site's Site manager or lead program.</p>
          </section>
        </div>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" value="close">Close</button>
      </div>
    </form>
  </dialog>`;
}

function adminUserLifecycleStatus(user) {
  if (user.lifecycleStatus) return user.lifecycleStatus;
  if (user.enabled === false) return "suspended";
  return user.status === "FORCE_CHANGE_PASSWORD" ? "invited" : "active";
}

function discardChangesDialog() {
  return `<dialog id="site-unsaved-dialog" class="places-modal site-admin-discard-dialog" aria-labelledby="site-unsaved-title" aria-describedby="site-unsaved-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="site-unsaved-title">${escapeHtml(t("siteAdmin.discard.title"))}</h2>
        <p class="places-modal__text" id="site-unsaved-copy">${escapeHtml(t("siteAdmin.discard.text"))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="keep">${escapeHtml(t("common.keepEditing"))}</button>
        <button class="btn-danger" value="discard">${escapeHtml(t("common.discardChanges"))}</button>
      </div>
    </form>
  </dialog>`;
}

function managerProgramChangeDialog() {
  return `<dialog id="manager-program-change-dialog" class="places-modal" aria-labelledby="manager-program-change-title" aria-describedby="manager-program-change-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="manager-program-change-title">Confirm move to a new program</h2>
        <p class="places-modal__text" id="manager-program-change-copy">This will remove the manager from any sites associated with the current program. They will immediately lose access to the Good Neighbor app for those sites.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Confirm change</button>
        <button class="btn-outline" value="cancel">Cancel change</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {string} managerName */
function removeSiteManagerDialog(managerName) {
  return `<dialog id="remove-site-manager-dialog" class="places-modal" aria-labelledby="remove-site-manager-title" aria-describedby="remove-site-manager-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="remove-site-manager-title">Remove ${escapeHtml(managerName)}?</h2>
        <p class="places-modal__text" id="remove-site-manager-copy">This will permanently remove the manager, remove them from every assigned Site, and immediately revoke their Good Neighbor app access.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">${escapeHtml(t("admin.managers.deleteRecord"))}</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {string} siteName */
function deactivateSiteSection(siteName) {
  return `<section class="subsection" aria-labelledby="deactivate-site-title">
    <h2 id="deactivate-site-title">${escapeHtml(t("admin.site.deactivate"))}</h2>
    <p id="deactivate-site-copy" class="muted">${escapeHtml(t("admin.site.deactivateDescription"))}</p>
    <form id="deactivate-site-form" class="inline-form destructive-confirmation" aria-describedby="deactivate-site-copy">
      <wa-input name="confirmation" required autocomplete="off" label="${escapeHtml(t("admin.site.deactivateConfirmation", { name: siteName }))}"></wa-input>
      <button class="btn-danger" type="submit" disabled>${escapeHtml(t("admin.site.deactivate"))}</button>
    </form>
  </section>`;
}

/** @param {string} siteId @param {string} current */
function siteSectionNav(siteId, current) {
  const sections = [
    ["details", "Site details"],
    ["oversight", "Oversight"],
    ["compliance", "Compliance"],
    ["access", "App access"],
  ];
  return `<nav class="entity-tabs" aria-label="Site sections">${sections
    .map(
      ([value, label]) =>
        `<a href="/sites/${encodeURIComponent(siteId)}?section=${value}" data-route ${value === current ? 'aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
}

/** @param {AdminState} state @param {string} section @param {string} [subview] */
function siteSectionView(state, section, subview = "") {
  const site = /** @type {AdminSite} */ (state.site);
  const readOnly = canEditSite(state)
    ? ""
    : `<wa-callout variant="warning" appearance="filled" size="small" role="status"><wa-icon slot="icon" name="triangle-exclamation" aria-hidden="true"></wa-icon>${escapeHtml(t("admin.sites.readOnly"))}</wa-callout>`;
  if (section === "oversight")
    return `${readOnly}${siteOversightView(state)}${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}`;
  if (section === "compliance") {
    return `${readOnly}${siteComplianceSummaryView(state)}${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}${siteTermsView(state)}${siteLettersView(state)}${sitePerimeterView(state)}${complianceReasonsDialog()}`;
  }
  if (section === "access") return readOnly + siteAccessView(state);
  return `${readOnly}${siteEditor(state)}
    ${state.siteSaveMessage ? `<p id="site-save-status" class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    ${state.capabilities.createEntities ? deactivateSiteSection(site.name) : ""}
    `;
}

/** @param {AdminState} state */
function sitePerimeterView(state) {
  const site = /** @type {AdminSite} */ (state.site);
  const conflict = state.perimeterError.includes("Reload the latest version");
  const updatedBy =
    site.perimeterUpdatedSource === "good-neighbor"
      ? ` ${escapeHtml(t(site.perimeterUpdatedDeviceLabel ? "admin.perimeter.appDeviceLabel" : "admin.perimeter.appDeviceId", { device: site.perimeterUpdatedDeviceLabel || site.perimeterUpdatedBy }))}`
      : site.perimeterUpdatedBy
        ? ` by ${escapeHtml(site.perimeterUpdatedBy)}`
        : "";
  return `<section class="subsection" aria-labelledby="perimeter-title">
    <div>
      <h2 id="perimeter-title">Perimeter</h2>
      <p class="muted">${escapeHtml(t("admin.perimeter.descriptionHint"))}</p>
    </div>
    <form id="site-perimeter-form" class="site-details-form" data-dirty-form>
      <wa-textarea class="perimeter-description" label="Perimeter description" name="perimeter" rows="8" maxlength="4000" value="${escapeHtml(site.perimeter || "")}" placeholder="e.g., &quot;16th Street between #1456 and #1756&quot;" required></wa-textarea>
      <div class="form-actions">
        <button class="btn-primary" type="submit" data-save-button disabled>${state.perimeterSaving ? "Saving…" : "Save perimeter"}</button>
      </div>
    </form>
    ${site.perimeterUpdatedAt ? `<p class="muted">Last updated ${escapeHtml(formatTimestamp(site.perimeterUpdatedAt))}${updatedBy}.</p>` : ""}
    ${state.perimeterError ? `<div class="error site-details-form__message" role="alert"><p>${escapeHtml(state.perimeterError)}</p>${conflict ? '<button class="btn-secondary" id="reload-site-perimeter" type="button">Reload latest Site</button>' : ""}</div>` : ""}
    ${state.perimeterMessage ? `<p class="success" role="status">${escapeHtml(state.perimeterMessage)}</p>` : ""}
  </section>`;
}

/** @param {AdminState} state */
function siteTermsView(state) {
  const terms = [...state.siteTerms].sort((a, b) =>
    String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
  );
  const active = activeSiteTerms(terms);
  const history = terms.filter((term) => term !== active);
  return `<section class="subsection" aria-labelledby="terms-title">
    <details data-site-terms ${state.expandedTermsSiteId === state.site.siteId ? "open" : ""}>
      <summary><h2 id="terms-title">${escapeHtml(t("admin.compliance.pastPeriods"))}</h2></summary>
      ${termsHistory(history, "No past perimeter check compliance periods.", true)}
    </details>
  </section>`;
}

function siteLettersView(state) {
  const site = state.site;
  const current = site?.complianceLetters?.current;
  const past = site?.complianceLetters?.past || [];
  const emails = [...(state.letterEmailHistory || [])].sort(
    (a, b) => a.number - b.number,
  );
  return `<section class="subsection" aria-labelledby="letters-title"><details data-site-letters ${state.expandedLettersSiteId === site.siteId ? "open" : ""}>
    <summary><h2 id="letters-title">${escapeHtml(t("admin.letters.title"))}</h2></summary>
    ${current ? `<div class="compliance-letter-preview">${current.previewUrl && current.url ? `<a class="compliance-letter-preview__thumbnail" href="${escapeHtml(current.url)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(current.fileName || "the current perimeter check letter")}"><img src="${escapeHtml(current.previewUrl)}" alt="" loading="lazy" /></a>` : ""}<p>Current letter: ${current.url ? `<a href="${escapeHtml(current.url)}" target="_blank" rel="noopener">${escapeHtml(current.fileName || "Open PDF")}</a>` : escapeHtml(current.fileName || current.status || "Generating")}</p>${current.termsVersionId ? `<button type="button" class="btn-secondary" data-resend-letter>${escapeHtml(t("admin.letters.resend"))}</button>` : ""}</div>` : `<p class="${state.site?.letterState === "draft_pending" ? "" : "empty-state"}">${state.site?.letterState === "draft_pending" ? "The letter is being generated." : "No letter has been generated yet"}</p>`}
    <h3>Past letters</h3>
    ${past.length ? `<ul>${past.map((letter) => `<li>${letter.url ? `<a href="${escapeHtml(letter.url)}" target="_blank" rel="noopener">${escapeHtml(letter.fileName || letter.createdAt || "Previous letter")}</a>` : escapeHtml(letter.fileName || letter.createdAt || "Previous letter")}</li>`).join("")}</ul>` : '<p class="empty-state">No past letters.</p>'}
    <h3>${escapeHtml(t("admin.letters.emailHistory"))}</h3>
    ${state.letterEmailUncertain ? `<p class="error" role="alert">${escapeHtml(t("admin.letters.deliveryUncertain"))}</p>` : ""}
    ${emails.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">#</th><th scope="col">${escapeHtml(t("admin.letters.letterLink"))}</th><th scope="col">${escapeHtml(t("admin.letters.sentTo"))}</th><th scope="col">${escapeHtml(t("admin.letters.dateSent"))}</th></tr></thead><tbody>${emails.map((email) => `<tr><td>${email.number}</td><td><a href="${escapeHtml(email.letter.url)}" target="_blank" rel="noopener">${escapeHtml(email.letter.fileName)}</a></td><td>${(email.recipients || []).map((address) => escapeHtml(address)).join("<br>") || "—"}</td><td>${escapeHtml(formatTimestamp(email.sentAt))}${email.provider === "local-preview" ? ` (${escapeHtml(t("admin.letters.localPreview"))})` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-state">${escapeHtml(t("admin.letters.noEmails"))}</p>`}
    ${state.letterHistoryCursor ? `<button class="btn-secondary" id="more-letter-history" type="button">${escapeHtml(t("admin.status.loadMore"))}</button>` : ""}
  </details></section>`;
}

/** @param {any[]} terms @param {string} [emptyMessage] @param {boolean} [past] */
function termsHistory(
  terms,
  emptyMessage = "No effective-dated terms have been added.",
  past = false,
) {
  if (!terms.length)
    return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table class="compliance-terms-table"><colgroup><col class="compliance-terms-date"><col class="compliance-terms-date"><col class="compliance-terms-reasons"><col class="compliance-terms-monitoring"><col class="compliance-terms-cadence"><col class="compliance-terms-created"></colgroup><thead><tr><th>${escapeHtml(t("admin.compliance.started"))}</th><th>${escapeHtml(t(past ? "admin.compliance.ended" : "admin.compliance.ends"))}</th><th>${escapeHtml(t("admin.compliance.reasonsGiven"))}</th><th>${escapeHtml(t("siteAdmin.compliance.enhancedMonitoring"))}</th><th>Checks/day</th><th>Created</th></tr></thead><tbody>${terms
    .map(
      (term) =>
        `<tr><td>${escapeHtml(term.effectiveStart)}</td><td>${escapeHtml(term.endedOn || term.periodEnd || (past ? "Until further notice" : t("admin.compliance.noEndDate")))}</td><td>${(term.reasons || []).length ? term.reasons.map((reason) => `<button type="button" class="btn-link compliance-reason-link" data-compliance-reason="${escapeHtml(reason)}" aria-haspopup="dialog" aria-controls="compliance-reasons-dialog" aria-label="${escapeHtml(t("admin.compliance.viewReason", { number: reason }))}">${escapeHtml(reason)}</button>`).join(", ") : "Legacy period"}</td><td>${escapeHtml(t(term.underEnhancedMonitoring ? "admin.compliance.yes" : "admin.compliance.no"))}</td><td>${escapeHtml(term.requiredChecksPerDay)}</td><td>${escapeHtml(formatTimestamp(term.createdAt))}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function firstDayOfNextMonth() {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setMonth(value.getMonth() + 1, 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-01`;
}

/** @param {AdminState} state */
function siteAccessView(state) {
  const revocableDevices = state.devices.filter(
    (device) => device.status !== "revoked",
  );
  return `<section class="subsection site-access" aria-label="App access">
    <h2>${escapeHtml(t("admin.enrollment.siteAccessTitle"))}</h2>
    <p class="muted">${escapeHtml(t("admin.enrollment.instructions"))}</p>
    ${managerMembershipList(state.managerMemberships, state.site.siteId)}
    ${managerGrantList(state.managerGrants)}
    <h2>${escapeHtml(t("admin.enrollment.enrolledDevices"))}</h2>
    ${revocableDevices.length ? "" : '<p class="empty-state">No devices in use.</p>'}
    ${state.revocationMessage ? `<p class="success" role="status">${escapeHtml(state.revocationMessage)}</p>` : ""}
    <div class="device-list">${revocableDevices
      .map((device) => {
        const id = device.bindingId || device.deviceId;
        const label = device.label || shortOpaqueId(id);
        const attribution =
          device.managerEmail ||
          (device.enrolledByEmail
            ? t("admin.devices.enrolledBy", { email: device.enrolledByEmail })
            : t("admin.devices.emailUnavailable"));
        return `<div class="device-row"><div class="device-row__details"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(attribution)}</span><span>${escapeHtml(t("admin.devices.identifier", { id: shortOpaqueId(id) }))}</span><span>${escapeHtml(t("admin.devices.lastSeen", { date: formatTimestamp(device.lastSeenAt) }))}</span></div><button class="btn-icon device-remove" type="button" data-revoke-device="${escapeHtml(id)}" aria-label="${escapeHtml(t("admin.devices.removeFromSite", { name: label }))}" title="${escapeHtml(t("admin.devices.removeFromSite", { name: label }))}"><wa-icon name="trash" aria-hidden="true"></wa-icon></button></div>`;
      })
      .join("")}</div>
    <form id="revoke-all-site-devices" class="inline-form destructive-confirmation"><wa-input id="revoke-all-confirmation" name="confirmation" autocomplete="off"><span slot="label">Type <strong>${escapeHtml(state.site.name)}</strong> to revoke access for every device used on this site</span></wa-input><button class="btn-danger" type="submit" disabled>Revoke all devices at this Site</button></form>
  </section>`;
}

/** @param {AdminState} state */
function siteManagersEditorView(state) {
  const hasCurrentManager = state.managerMemberships.length > 0;
  const availableManagers = state.availableSiteUsers.filter(
    (user) =>
      !state.managerMemberships.some(
        (member) =>
          (member.personId === user.personId && !!user.personId) ||
          member.userId === user.userId ||
          (!member.userId &&
            member.email?.toLowerCase() === user.email?.toLowerCase()),
      ),
  );
  const managerPrompt = t(
    hasCurrentManager
      ? "admin.siteManagers.addAnother"
      : "admin.siteManagers.choose",
  );
  return `<section class="subsection" aria-labelledby="site-managers-title">
    <h2 id="site-managers-title">${escapeHtml(t("admin.siteManagers.title"))}</h2>
    <p>${escapeHtml(t("admin.siteManagers.description"))}</p>
    ${managerMembershipList(state.managerMemberships, state.site.siteId, true, canEditSite(state))}
    ${
      canEditSite(state)
        ? `<form id="manager-membership-form" class="inline-form manager-membership-form">
      <wa-select name="manager-user-id" aria-label="${escapeHtml(managerPrompt)}" placeholder="${escapeHtml(managerPrompt)}" >
        ${availableManagers
          .map(
            (user) =>
              `<wa-option value="${escapeHtml(user.userId)}">${escapeHtml(`${user.firstName} ${user.lastName}`)}</wa-option>`,
          )
          .join("")}
        <wa-option value="__create_site_manager__">${escapeHtml(t("admin.siteManagers.createNew"))}</wa-option>
      </wa-select>
      <div class="manager-membership-actions" data-manager-membership-actions hidden>
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.siteManagers.assignToSite"))}</button>
        <button class="btn-outline" type="button" data-cancel-manager-assignment>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>`
        : ""
    }
    ${canEditSite(state) ? newSiteManagerDialog() : ""}

    ${removeManagerMembershipDialog(state.managerMembershipRemovalTarget, state.site.name)}
  </section>`;
}

function newSiteManagerDialog() {
  return `<dialog id="new-site-manager-dialog" class="places-modal" aria-labelledby="new-site-manager-title">
    <form id="new-site-manager-form" class="places-modal__card site-details-form">
      <h2 id="new-site-manager-title">${escapeHtml(t("admin.siteManagers.newTitle"))}</h2>
      ${formInput("new-manager-first-name", t("admin.programs.firstName"), "", { required: true, autocomplete: "given-name" })}
      ${formInput("new-manager-last-name", t("admin.programs.lastName"), "", { required: true, autocomplete: "family-name" })}
      ${phoneInput("new-manager-phone", t("admin.programs.phone"), "", { required: true, type: "tel", autocomplete: "tel" })}
      ${formInput("new-manager-email", t("admin.programs.email"), "", { required: true, type: "email", autocomplete: "email" })}
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("common.save"))}</button>
        <button class="btn-outline" type="button" data-cancel-new-site-manager>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {any | null} preview */
function physicalDeviceRevocationConfirmation(preview) {
  if (!preview) return "";
  return `<form id="physical-device-revocation" class="site-details-form" aria-labelledby="physical-device-revocation-title">
    <fieldset>
      <legend id="physical-device-revocation-title">Remove ${escapeHtml(preview.label)} access to all sites</legend>
      <p>This permanently removes ${escapeHtml(preview.bindings.length)} active Site binding${preview.bindings.length === 1 ? "" : "s"} on this physical device:</p>
      ${preview.bindings.length ? `<ul>${preview.bindings.map((binding) => `<li>${escapeHtml(binding.siteName)} — ${escapeHtml(binding.accessLevel)}</li>`).join("")}</ul>` : '<p class="empty-state">No active Site bindings remain.</p>'}
      <wa-input id="physical-device-confirmation" name="confirmation" required autocomplete="off"><span slot="label">Type <strong>${escapeHtml(preview.label)}</strong> exactly to continue</span></wa-input>
    </fieldset>
    <div class="row"><button class="btn-danger" type="submit">Remove access to all sites</button><button class="btn-secondary" id="cancel-physical-device-revocation" type="button">Cancel</button></div>
  </form>`;
}

/** @param {any | null} device */
function deviceSuspensionForm(device) {
  if (!device) return "";
  return `<form id="device-suspension" class="site-details-form" aria-labelledby="device-suspension-title">
    <fieldset><legend id="device-suspension-title">Suspend ${escapeHtml(device.label || "device binding")}</legend>
      <p>Suspension invalidates this Site binding immediately. It cannot be reinstated; returning the device to service requires a new single-Site enrollment grant.</p>
      <wa-select id="device-suspension-reason" name="reason" label="Reason" placeholder="Choose a reason" required>
        <wa-option value="security_review">Security review</wa-option>
        <wa-option value="lost_or_unaccounted_device">Lost or unaccounted device</wa-option>
        <wa-option value="refresh_replay">Refresh-token replay</wa-option>
        <wa-option value="policy_violation">Policy violation</wa-option>
      </wa-select>
    </fieldset>
    <div class="row"><button class="btn-danger" type="submit">Suspend binding</button><button class="btn-secondary" id="cancel-device-suspension" type="button">Cancel</button></div>
  </form>`;
}

/** @param {unknown} reason */
function suspensionReasonLabel(reason) {
  return (
    {
      security_review: "Security review",
      lost_or_unaccounted_device: "Lost or unaccounted device",
      refresh_replay: "Refresh-token replay",
      policy_violation: "Policy violation",
    }[String(reason ?? "")] || "Reason not recorded"
  );
}

/** @param {AdminState} state */
function emergencySiteRevocationPanel(state) {
  const preview = state.emergencyRevocationPreview;
  if (preview) {
    return `<form id="emergency-site-confirmation" class="site-details-form" aria-labelledby="emergency-confirmation-title">
      <fieldset><legend id="emergency-confirmation-title">Confirm emergency revocation across Sites</legend>
        <p>Credentials will be invalidated immediately for every selected Site. Device records will then be reconciled in the background.</p>
        ${preview.sites
          .map(
            (site) =>
              `<section><h4>${escapeHtml(site.siteName)}</h4><p>${escapeHtml(site.bindings.length)} active binding${site.bindings.length === 1 ? "" : "s"}</p>${site.bindings.length ? `<ul>${site.bindings.map((binding) => `<li>${escapeHtml(binding.label || shortOpaqueId(binding.bindingId))} — ${escapeHtml(binding.legacy ? "legacy device" : binding.accessLevel)}</li>`).join("")}</ul>` : ""}</section>`,
          )
          .join("")}
        <wa-input id="emergency-revocation-confirmation" name="confirmation" required autocomplete="off"><span slot="label">Type <strong>${escapeHtml(preview.confirmation)}</strong> exactly to continue</span></wa-input>
      </fieldset>
      <div class="row"><button class="btn-danger" type="submit">Invalidate credentials across Sites</button><button class="btn-secondary" type="button" data-cancel-emergency-revocation>Cancel</button></div>
    </form>`;
  }
  if (!state.emergencyRevocationSites.length) return "";
  return `<form id="emergency-site-selection" class="site-details-form" aria-labelledby="emergency-selection-title">
    <fieldset><legend id="emergency-selection-title">Choose Sites for emergency revocation</legend>
      <p>Select between 2 and 20 Sites. You will review every active binding before confirming.</p>
      <div class="list">${state.emergencyRevocationSites.map((site) => `<wa-checkbox name="site-id" value="${escapeHtml(site.siteId)}" ${site.siteId === state.site?.siteId ? "checked" : ""}>${escapeHtml(site.siteName)}${site.providerName ? ` — ${escapeHtml(site.providerName)}` : ""}</wa-checkbox>`).join("")}</div>
    </fieldset>
    <div class="row"><button class="btn-danger" type="submit">Review affected devices</button><button class="btn-secondary" type="button" data-cancel-emergency-revocation>Cancel</button></div>
  </form>`;
}

/** @param {any[]} memberships @param {string} siteId @param {boolean} [editing] @param {boolean} [canManage] */
function managerMembershipList(
  memberships,
  siteId,
  editing = false,
  canManage = false,
) {
  if (!memberships.length) {
    return `<p class="empty-state">${escapeHtml(t("admin.siteManagers.none"))}</p>`;
  }
  return `<ul class="contact-list">${memberships
    .map(
      (membership) => `<li>
        <div><strong>${escapeHtml(membership.name)}</strong><span><a href="mailto:${escapeHtml(membership.email)}">${escapeHtml(membership.email)}</a></span><span class="muted">Has ${escapeHtml(membership.activeBindingCount || 0)} active device${Number(membership.activeBindingCount || 0) === 1 ? "" : "s"} in use at this site</span></div>
        <div class="contact-list__actions">${
          editing
            ? `${(membership.personId || membership.userId) && canManage ? `<a class="btn-secondary" href="/managers/${encodeURIComponent(membership.personId || membership.userId)}?returnSite=${encodeURIComponent(siteId)}" data-route>${escapeHtml(t("common.edit"))}</a>` : ""}${canManage ? `<button class="btn-danger" type="button" data-remove-manager-membership="${escapeHtml(membership.membershipId)}">${escapeHtml(t("admin.siteManagers.remove"))}</button>` : ""}`
            : `<button class="btn-secondary" type="button" data-issue-manager-grant="${escapeHtml(membership.membershipId)}" data-delivery-mode="link">${escapeHtml(t("admin.enrollment.emailMagicLink"))}</button><button class="btn-secondary" type="button" data-issue-manager-grant="${escapeHtml(membership.membershipId)}" data-delivery-mode="code">${escapeHtml(t("admin.enrollment.emailOneTimeCode"))}</button>`
        }</div>
      </li>`,
    )
    .join("")}</ul>`;
}

/** @param {any | null} membership @param {string} siteName */
function removeManagerMembershipDialog(membership, siteName) {
  if (!membership) return "";
  const deviceCount = Number(membership.activeBindingCount || 0);
  return `<dialog id="remove-manager-membership-dialog" class="places-modal" aria-labelledby="remove-manager-membership-title" aria-describedby="remove-manager-membership-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="remove-manager-membership-title">Remove ${escapeHtml(membership.name)} as site manager?</h2>
        <p class="places-modal__text" id="remove-manager-membership-copy">This will remove them from ${escapeHtml(siteName)} and immediately revoke access for ${escapeHtml(deviceCount)} active device${deviceCount === 1 ? "" : "s"} at this site. Their assignments at other sites will remain active.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Remove site manager</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {any[]} grants */
function managerGrantList(grants) {
  if (!grants.length)
    return `<details class="table-disclosure site-enrollment-history"><summary>${escapeHtml(t("admin.enrollment.history", { count: 0 }))}</summary><p class="empty-state">No enrollment links issued.</p></details>`;
  const hasCopyableLink = grants.some((grant) => Boolean(grant.enrollmentUrl));
  return `<details class="table-disclosure site-enrollment-history"><summary>${escapeHtml(t("admin.enrollment.history", { count: grants.length }))}</summary><div class="table-wrap"><table><thead><tr><th>Recipient</th><th>${escapeHtml(t("admin.enrollment.type"))}</th><th>Issued</th><th>Expires</th><th>Status</th><th>${escapeHtml(t("admin.enrollment.delivery"))}</th><th>Security notice</th>${hasCopyableLink ? `<th>${escapeHtml(t("admin.enrollment.link"))}</th>` : ""}<th>Action</th></tr></thead><tbody>${grants
    .map(
      (grant) =>
        `<tr><td>${escapeHtml(grant.issuedTo)}</td><td>${escapeHtml(t(grant.deliveryMode === "code" ? "admin.enrollment.oneTimeCode" : "admin.enrollment.magicLink"))}</td><td>${escapeHtml(formatTimestamp(grant.createdAt))}</td><td>${escapeHtml(formatTimestamp(grant.expiresAt))}</td><td>${escapeHtml(grant.status)}</td><td>${escapeHtml(grant.deliveryStatus || "queued")}</td><td>${escapeHtml(grant.securityNotificationStatus || (grant.status === "redeemed" ? "pending" : "Not applicable"))}</td>${hasCopyableLink ? `<td>${grant.enrollmentUrl ? `<button class="btn-secondary enrollment-copy" type="button" data-copy-enrollment-url="${escapeHtml(grant.enrollmentUrl)}" aria-label="${escapeHtml(t("admin.enrollment.copyFor", { email: grant.issuedTo }))}">${escapeHtml(t("admin.enrollment.copy"))}</button><span class="visually-hidden" aria-live="polite" data-copy-status></span>` : "—"}</td>` : ""}<td>${grant.status === "pending" ? `<button class="btn-danger" type="button" data-cancel-manager-grant="${escapeHtml(grant.grantId)}">Cancel</button>` : "—"}</td></tr>`,
    )
    .join("")}</tbody></table></div></details>`;
}

/** @param {unknown} value */
function shortOpaqueId(value) {
  const id = String(value || "");
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/**
 * Render the top-level entity directory without fetching every provider record.
 * Sites are intentionally discovered through their provider until a paginated,
 * server-side site directory endpoint is available.
 * @param {AdminState} state
 * @param {{ name: string, id: string }} route
 */
function directoryView(state, route) {
  const section =
    route.name === "provider-managers"
      ? "provider-managers"
      : route.name.startsWith("manager")
        ? "managers"
        : route.name.startsWith("provider") || route.name === "programs"
          ? "providers"
          : "sites";
  const params = new URLSearchParams(window.location.search);
  const search = (params.get("q") || "").trim();
  const filterParams = {
    manager: defaultProgramManagerFilter(
      state.role,
      state.profile,
      params.get("manager"),
    ),
    department: params.get("department") || "",
    system: params.get("system") || "",
  };
  return `<section class="directory" aria-labelledby="directory-title">
    <div class="page-head">
      <div>
        <h1 id="directory-title" tabindex="-1">${escapeHtml(t("admin.breadcrumb.admin"))}</h1>
        <p class="muted">Manage providers, programs, sites, enrollment, and devices.</p>
      </div>
    </div>
    <form id="directory-search" class="directory-search" role="search">
      <label class="visually-hidden" for="directory-search-input">Search providers, programs, sites, or managers</label>
      <div class="directory-search__controls">
        <wa-input id="directory-search-input" name="q" type="search" value="${escapeHtml(search)}" placeholder="Search providers, programs, sites, or managers" aria-label="Search providers, programs, sites, or managers" pill with-clear><wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon></wa-input>
        <button class="btn-link" id="clear-directory-search" type="button" ${search ? "" : "hidden"}>Clear</button>
      </div>
    </form>
    <div id="directory-results">
    ${
      !search
        ? `<nav class="entity-tabs" aria-label="${escapeHtml(t("admin.directory.sections"))}">
      ${directoryTab("sites", "Sites", section, search)}
      ${directoryTab("managers", "Site managers", section, search)}
      ${state.capabilities?.manageProviderManagers ? directoryTab("provider-managers", escapeHtml(t("admin.providerManagers.title")), section, search) : ""}
      ${directoryTab("providers", "Providers & Programs", section, search)}
    </nav>`
        : ""
    }
    ${search && section !== "provider-managers" ? globalDirectorySearch(state, search) : ""}
    ${section === "provider-managers" ? providerManagerDirectoryView(state, search) : ""}
    ${!search && section === "sites" ? siteDirectory(state, filterParams) : ""}
    ${!search && section === "providers" ? providerDirectory(state.providers) : ""}
    ${!search && section === "managers" ? siteManagerDirectory(state, { program: params.get("program") || "", site: params.get("site") || "" }, search) : ""}
    </div>
  </section>`;
}

/** @param {string} kind @param {string} label @param {string} current @param {string} search */
function directoryTab(kind, label, current, search) {
  const query = search ? `?q=${encodeURIComponent(search)}` : "";
  return `<a href="/${kind}${query}" data-route ${kind === current ? 'aria-current="page"' : ""}>${label}</a>`;
}

/** @param {AdminState} state @param {{ manager: string, department: string, system: string }} selected */
function siteDirectory(state, selected) {
  const sites = state.sites.filter((site) => site.status !== "inactive");
  const managers = new Map(
    state.programManagers.map((manager) => [
      `id:${manager.userId}`,
      {
        value: `id:${manager.userId}`,
        name:
          manager.name ||
          [manager.firstName, manager.lastName].filter(Boolean).join(" "),
      },
    ]),
  );
  if (state.role === "compliance-manager" && state.profile) {
    const value = defaultProgramManagerFilter(state.role, state.profile, null);
    managers.set(value, {
      value,
      name:
        [state.profile.firstName, state.profile.lastName]
          .filter(Boolean)
          .join(" ") || state.profile.email,
    });
  }
  // Keep legacy name-based filter links and sites without directory IDs usable.
  for (const site of sites) {
    const name = site.oversight?.cityProgramManager;
    if (
      name &&
      ![...managers.values()].some((manager) => manager.name === name)
    )
      managers.set(name, { value: name, name });
  }
  if (
    selected.manager &&
    !selected.manager.startsWith("id:") &&
    !managers.has(selected.manager)
  ) {
    managers.set(selected.manager, {
      value: selected.manager,
      name: selected.manager,
    });
  }
  const options = (field) =>
    [
      ...new Set(sites.map((site) => site.oversight?.[field]).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
  const filtered = sites
    .filter(
      (site) =>
        matchesProgramManager(site, selected.manager) &&
        (!selected.department ||
          site.oversight?.managingCityDepartment === selected.department) &&
        (!selected.system ||
          site.oversight?.managingSystemOfCare === selected.system),
    )
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `<section class="site-directory" aria-labelledby="sites-title">
    <div class="panel__head">
      <div>
        <h2 class="visually-hidden" id="sites-title">Sites</h2>
        <p class="muted">${filtered.length} ${filtered.length === 1 ? "site" : "sites"}</p>
      </div>
      <a class="btn-link" href="/sites/new" data-route>Add new site</a>
    </div>
    <form id="site-directory-filters" class="directory-filters" aria-label="Filter sites">
      <wa-select name="manager" aria-label="All program managers" placeholder="All program managers" value="${escapeHtml(selected.manager)}" size="s" pill><wa-option value="">All program managers</wa-option>${[
        ...managers.values(),
      ]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (manager) =>
            `<wa-option value="${escapeHtml(manager.value)}">${escapeHtml(manager.name)}</wa-option>`,
        )
        .join("")}</wa-select>
      ${filterSelect("department", "All departments", options("managingCityDepartment"), selected.department)}
      ${filterSelect("system", "All systems of care", options("managingSystemOfCare"), selected.system)}
    </form>
    ${
      filtered.length
        ? `<ul class="site-directory-list">${filtered
            .map((site) => {
              const managerName = (site.managerMemberships || [])
                .map((member) => member.name)
                .filter(Boolean)
                .join(", ");
              const manager = managerName || "Site manager not assigned";
              const program = state.programs.find(
                (program) => program.programId === site.leadProgramId,
              );
              const leadProgramName = site.programName || program?.name;
              const providerId = site.providerId || program?.providerId;
              const providerName =
                state.providers.find(
                  (provider) => provider.providerId === providerId,
                )?.name ||
                site.providerName ||
                program?.providerName;
              const description = [
                ["hand-holding-heart", providerName],
                ["puzzle-piece", leadProgramName || "No lead program assigned"],
                ["users", manager],
              ]
                .filter(([, label]) => Boolean(label))
                .map(
                  ([icon, label]) =>
                    `<span class="site-directory-meta__item"><wa-icon name="${icon}" aria-hidden="true"></wa-icon><span>${escapeHtml(label)}</span></span>`,
                )
                .join(
                  '<span class="site-directory-meta__separator" aria-hidden="true">·</span>',
                );
              const siteUrl = `/sites/${encodeURIComponent(site.siteId)}`;
              return `<li><div class="site-directory-row site-directory-row--actions"><a class="site-directory-row__main" href="${siteUrl}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(site.name || site.siteName || site.siteId)}</strong><span class="site-directory-meta">${description}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a><div class="site-directory-row__actions"><a class="btn-secondary" href="${siteUrl}?section=compliance" data-route>${escapeHtml(t("admin.sites.updatePerimeterChecks"))}</a><a class="btn-secondary" href="${siteUrl}?section=access" data-route>${escapeHtml(t("admin.sites.giveAppAccess"))}</a></div></div></li>`;
            })
            .join("")}</ul>`
        : '<p class="empty-state">No sites match these filters.</p>'
    }
  </section>`;
}

/** @param {string} name @param {string} label @param {string[]} values @param {string} selected */
function filterSelect(name, label, values, selected) {
  return `<wa-select name="${name}" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(label)}" value="${escapeHtml(selected)}" size="s" pill><wa-option value="">${escapeHtml(label)}</wa-option>${values.map((value) => `<wa-option value="${escapeHtml(value)}">${escapeHtml(value)}</wa-option>`).join("")}</wa-select>`;
}

/** @param {AdminState} state @param {{ program: string, site: string }} selected @param {string} search */
function siteManagerDirectory(state, selected, search) {
  const managers = state.siteManagers.filter((manager) => {
    const matchesSearch =
      !search ||
      [
        manager.firstName,
        manager.lastName,
        manager.email,
        manager.programName,
        ...(manager.assignedSites || []).map((site) => site.siteName),
      ].some((value) =>
        String(value || "")
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
      );
    return (
      matchesSearch &&
      (!selected.program || manager.programId === selected.program) &&
      (!selected.site ||
        (manager.assignedSites || []).some(
          (site) => site.siteId === selected.site,
        ))
    );
  });
  const programs = state.programs
    .filter((program) => program.status !== "inactive")
    .sort((a, b) => a.name.localeCompare(b.name));
  const sites = state.sites
    .filter((site) => site.status !== "inactive")
    .sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  return `<section class="site-directory" aria-labelledby="managers-title">
    <div class="panel__head">
      <div><h2 class="visually-hidden" id="managers-title">Site managers</h2><p class="muted">${managers.length} ${managers.length === 1 ? "manager" : "managers"}</p></div>
      <a class="btn-link" href="/managers/new" data-route>${escapeHtml(t("admin.managers.addSiteManager"))}</a>
    </div>
    <form id="manager-directory-filters" class="directory-filters" aria-label="Filter site managers">
      ${objectFilterSelect("program", "All programs", programs, selected.program, "programId", "name")}
      ${objectFilterSelect("site", "All sites", sites, selected.site, "siteId", "name")}
    </form>
    ${
      managers.length
        ? `<ul class="site-directory-list">${managers
            .map((manager) => {
              const sitesLabel =
                (manager.assignedSites || [])
                  .map((site) => site.siteName)
                  .join(", ") || "No site assigned";
              return `<li><a class="site-directory-row" href="/managers/${encodeURIComponent(manager.userId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(`${manager.firstName} ${manager.lastName}`.trim())}</strong><span>${escapeHtml(manager.programName)} · ${escapeHtml(sitesLabel)}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`;
            })
            .join("")}</ul>`
        : '<p class="empty-state">No site managers match these filters.</p>'
    }
  </section>`;
}

function objectFilterSelect(name, label, values, selected, valueKey, labelKey) {
  return `<wa-select name="${name}" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(label)}" value="${escapeHtml(selected)}" size="s" pill><wa-option value="">${escapeHtml(label)}</wa-option>${values.map((item) => `<wa-option value="${escapeHtml(item[valueKey])}">${escapeHtml(item[labelKey] || siteLabel(item))}</wa-option>`).join("")}</wa-select>`;
}

/** @param {AdminState} state @param {string} query */
function globalDirectorySearch(state, query) {
  const needle = query.trim().toLocaleLowerCase();
  const includes = (...values) =>
    values.some((value) =>
      String(value || "")
        .toLocaleLowerCase()
        .includes(needle),
    );
  const sites = state.sites.filter((site) =>
    includes(
      site.name,
      site.address,
      site.programName,
      site.providerName,
      site.oversight?.cityProgramManager,
      site.oversight?.managingCityDepartment,
      site.oversight?.managingSystemOfCare,
    ),
  );
  const programs = state.programs.filter((program) =>
    includes(program.name, program.providerName),
  );
  const providers = state.providers.filter((provider) =>
    includes(provider.name),
  );
  const managers = state.siteManagers.filter((manager) =>
    includes(
      `${manager.firstName || ""} ${manager.lastName || ""}`.trim(),
      manager.email,
      manager.programName,
      ...(manager.assignedSites || []).map((site) => site.siteName),
    ),
  );
  return `<section class="panel" aria-labelledby="directory-results-title"><h2 id="directory-results-title">${escapeHtml(t("admin.directory.results", { query }))}</h2>
    <p role="status">${escapeHtml(t(state.managerSearchFailed ? "admin.directory.managerError" : !state.managerDirectoryLoaded ? "admin.directory.managerLoading" : "admin.directory.resultCount", { count: sites.length + programs.length + providers.length + managers.length }))}</p>
    ${searchResultList(
      "Sites",
      sites,
      (site) => `/sites/${encodeURIComponent(site.siteId)}`,
      (site) => site.name || site.siteName,
    )}
    ${searchResultList(
      "Programs",
      programs,
      (program) => `/programs/${encodeURIComponent(program.programId)}`,
      (program) =>
        program.providerName
          ? `${program.name} — ${program.providerName}`
          : program.name,
    )}
    ${searchResultList(
      "Providers",
      providers,
      (provider) => `/providers/${encodeURIComponent(provider.providerId)}`,
      (provider) => provider.name,
    )}
    ${searchResultList(
      t("admin.directory.managers"),
      managers,
      (manager) => `/managers/${encodeURIComponent(manager.userId)}`,
      (manager) =>
        `${manager.firstName || ""} ${manager.lastName || ""}`.trim() ||
        manager.email,
    )}
  </section>`;
}

/** @param {string} title @param {any[]} items @param {(item: any) => string} href @param {(item: any) => string} label */
function searchResultList(title, items, href, label) {
  return items.length
    ? `<section class="search-result-group"><h3>${title}</h3>${entityList(items, href, label, () => "", "")}</section>`
    : "";
}

/** @param {AdminState} state */
function siteImportView(state) {
  const preview = state.importPreview;
  const counts = preview?.counts || {};
  const ready = Number(counts.create || 0) + Number(counts.reuse || 0);
  const acceptable = Number(counts.acceptable || 0);
  const applicable = ready + acceptable;
  const skipped = Number(counts.conflict || 0) + Number(counts.invalid || 0);
  const hasConflictReport =
    skipped > 0 ||
    Number(state.importResult?.outcomes?.skipped_conflict || 0) > 0 ||
    Number(state.importResult?.outcomes?.failed || 0) > 0;
  const uploadView = `<section class="panel" aria-labelledby="upload-title">
      <div class="panel__head import-upload-heading">
        <h2 id="upload-title">Upload new or updated site records</h2>
        <button class="btn-icon" id="show-import-help" type="button" aria-label="CSV upload requirements"><wa-icon name="circle-info" aria-hidden="true"></wa-icon></button>
      </div>
      <form id="site-import-form" class="site-import-form">
        <label class="file-picker">
          <span class="file-picker__control">
            <span class="file-picker__button">Choose CSV file</span>
            <span class="file-picker__name" id="site-import-file-name" aria-live="polite" hidden></span>
          </span>
          <input class="file-picker__input" name="site-import-file" type="file" accept="text/csv,.csv" aria-describedby="site-import-file-name" required />
        </label>
        <button class="btn-primary" type="submit" ${state.importBusy ? "disabled" : ""}>${state.importBusy ? "Working…" : "Preview import"}</button>
      </form>
    </section>
    ${pastImportsTable(state.importHistory)}
    ${siteImportHelpDialog()}`;
  const reviewView = `<section class="panel" aria-labelledby="review-title">
      <div class="panel__head"><h2 id="review-title">2. Review record completeness</h2><button class="btn-secondary" id="cancel-site-import" type="button" ${state.importBusy ? "disabled" : ""}>Cancel</button></div>
      <dl class="import-summary"><div><dt>Perfect</dt><dd>${ready}</dd></div><div><dt>Acceptable</dt><dd>${acceptable}</dd></div><div><dt>Not ready</dt><dd>${skipped}</dd></div></dl>
      ${importRowsTable(preview?.rows || [])}
      <div class="confirmation"><p><strong>Import ${applicable} perfect or acceptable rows; skip ${skipped} not-ready rows.</strong></p><button class="btn-primary" id="apply-site-import" type="button" ${state.importBusy ? "disabled" : ""}>Confirm and apply</button>${hasConflictReport ? '<button class="btn-secondary" id="download-import-conflicts" type="button">Download conflict CSV</button>' : ""}</div>
      ${state.importBusy ? '<div class="import-progress" role="status" aria-live="polite"><wa-spinner aria-hidden="true"></wa-spinner><span>Importing records…</span></div>' : ""}
    </section>`;
  return `<section class="directory" aria-labelledby="import-title">
    <a class="site-back-link" href="/sites" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div class="page-head"><div><h1 id="import-title" tabindex="-1">Import sites</h1><p class="muted">Upload a CSV file of sites, providers, programs, and contact details.</p></div></div>
    ${
      state.importNotice
        ? `<section class="panel" role="status">
      <p><strong>${escapeHtml(state.importNotice.title)}</strong></p>
      <p>${escapeHtml(state.importNotice.message)}</p>
      <button class="btn-secondary" id="dismiss-import-notice" type="button">${escapeHtml(t("toastUi.dismiss.aria", { title: state.importNotice.title }))}</button>
    </section>`
        : ""
    }
    ${preview ? reviewView : uploadView}
  </section>`;
}

/** @param {any[]} imports */
function pastImportsTable(imports) {
  const rows = imports.length
    ? imports
        .map((item) => {
          const status = importHistoryStatus(item);
          return `<tr>
            <td>${escapeHtml(item.fileName || "Imported CSV")}</td>
            <td>${escapeHtml(formatImportDate(item.completedAt))}</td>
            <td>${escapeHtml(formatImportTime(item.completedAt))}</td>
            <td><span class="status-badge status-badge--${status.tone}">${status.label}</span></td>
            <td>${escapeHtml(Number(item.recordsAdded || 0))} added · ${escapeHtml(Number(item.recordsUpdated || 0))} updated${status.failed ? ` · ${escapeHtml(status.failed)} failed` : ""}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="5" class="empty-state">No past imports.</td></tr>';
  return `<section class="panel" aria-labelledby="past-imports-title">
    <h2 id="past-imports-title">Past imports</h2>
    <div class="table-wrap"><table><thead><tr><th>Filename</th><th>Date</th><th>Time</th><th>Result</th><th>Records</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

/** @param {any} item */
function importHistoryStatus(item) {
  const failed =
    Number(item.recordsFailed || 0) ||
    Number(item.outcomes?.failed || 0) +
      Number(item.outcomes?.skipped_conflict || 0);
  const applied =
    Number(item.recordsAdded || 0) + Number(item.recordsUpdated || 0);
  const resultStatus =
    item.resultStatus ||
    (failed === 0 ? "succeeded" : applied > 0 ? "partial" : "failed");
  if (resultStatus === "failed") {
    return { label: "Failed", tone: "not-ready", failed };
  }
  if (resultStatus === "partial") {
    return { label: "Partial", tone: "acceptable", failed };
  }
  return { label: "Completed", tone: "ready", failed: 0 };
}

/** @param {{ title: string, message: string } | null} notice */

function siteImportHelpDialog() {
  return `<dialog id="site-import-help-dialog" class="places-modal" aria-labelledby="site-import-help-title">
    <form class="places-modal__card import-help" method="dialog">
      <div class="import-help__close-row">
        <button class="btn-icon" type="submit" value="close" aria-label="${escapeHtml(t("common.close"))}"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
      </div>
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="site-import-help-title">CSV upload requirements</h2>
        <div class="import-help__body">
          <p>Upload a UTF-8 CSV no larger than 1 MB or 500 data rows.</p>
          <p>The first row must contain these columns in this exact order:</p>
          <p class="column-list"><code>Provider</code>, <code>Program</code>, <code>Site name</code>, <code>Site address</code>, <code>Site type</code>, <code>Department</code>, <code>Site manager first name</code>, <code>Site manager last name</code>, <code>Site manager phone</code>, <code>Site manager extension</code>, <code>Site manager email</code>, <code>Program manager first name</code>, <code>Program manager last name</code>, <code>Program manager phone</code>, <code>Program manager extension</code>, <code>Program manager department</code>, <code>Program manager email</code>, <code>Provider manager first name</code>, <code>Provider manager last name</code>, <code>Provider manager phone</code>, <code>Provider manager extension</code>, <code>Provider manager email</code>.</p>
          <p>Program manager phone is required. Other phone and all extension columns may be blank. All remaining fields are required.</p>
          <p>Use another row with the same Site to add another Site manager, Program manager, or Provider manager. Put values containing commas in double quotes.</p>
          <p>Department names must match an existing department or one of the supported DPH and HSH names. Unknown names are held for manual resolution.</p>
        </div>
      </div>
    </form>
  </dialog>`;
}

/** @param {string | null | undefined} value */
function formatImportDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** @param {string | null | undefined} value */
function formatImportTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

/** @param {any[]} rows */
function importRowsTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Row</th><th>Site</th><th>Provider</th><th>Program</th><th>Reason</th></tr></thead><tbody>${rows
    .map((row) => {
      const status = importRowStatus(row);
      return `<tr><td><span class="status-badge status-badge--${status.tone}">${status.label}</span></td><td>${escapeHtml(row.rowNumber)}</td><td>${escapeHtml(row.source?.["Site name"] || "")}</td><td>${escapeHtml(row.source?.Provider || "")}</td><td>${escapeHtml(row.source?.Program || "")}</td><td>${escapeHtml(importRowReason(row))}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

/** @param {any} row */
function importRowStatus(row) {
  if (row.outcome === "applied") {
    return { label: "Imported", tone: "ready" };
  }
  if (row.outcome === "retryable_failed") {
    return { label: "Retry needed", tone: "acceptable" };
  }
  if (row.outcome === "failed" || row.outcome === "skipped_conflict") {
    return { label: "Not imported", tone: "not-ready" };
  }
  const classification = row.classification;
  if (classification === "create" || classification === "reuse") {
    return { label: "Perfect", tone: "ready" };
  }
  if (classification === "acceptable") {
    return { label: "Acceptable", tone: "acceptable" };
  }
  return { label: "Not ready", tone: "not-ready" };
}

/** @param {any} row */
function importRowReason(row) {
  if (row.reasonCode === "retryable_apply_error") {
    return row.outcome === "failed"
      ? "The temporary service error persisted, so this row was not imported."
      : "Temporary service error. The importer will retry this row.";
  }
  const applyFailureMessages = {
    invalid_apply_transaction:
      "The importer could not construct a valid database transaction.",
    import_service_configuration_error:
      "The import service is not configured correctly.",
    unexpected_apply_error: "The importer encountered an unexpected error.",
    changed_after_preview:
      "The underlying data changed after this preview was created.",
  };
  if (applyFailureMessages[row.reasonCode]) {
    return applyFailureMessages[row.reasonCode];
  }
  if (row.reasonCode === "missing_optional_value") {
    const missing = String(row.existingValue || "").trim();
    return missing ? `Missing optional: ${missing}` : "Optional fields missing";
  }
  if (row.reasonCode !== "missing_required_value") {
    return row.reasonCode || "—";
  }
  const missing = String(row.existingValue || "").trim();
  return missing ? `Missing: ${missing}` : "Missing required value";
}

/** @param {Record<string, number>} outcomes */
function importOutcomeSummary(outcomes) {
  return `<dl class="import-summary"><div><dt>Applied</dt><dd>${Number(outcomes.applied || 0)}</dd></div><div><dt>Skipped</dt><dd>${Number(outcomes.skipped || 0) + Number(outcomes.skipped_conflict || 0)}</dd></div><div><dt>Failed</dt><dd>${Number(outcomes.failed || 0)}</dd></div></dl>`;
}

/** @param {any[]} rows */
function importResultLinks(rows) {
  const applied = rows.filter(
    (row) => row.outcome === "applied" && row.resultIds?.siteId,
  );
  if (!applied.length) return "";
  return `<div><h3>Applied sites</h3><ul class="entity-list">${applied
    .map(
      (row) =>
        `<li><a class="entity-link" href="/sites/${encodeURIComponent(row.resultIds.siteId)}" data-route><span>${escapeHtml(row.source?.["Site name"] || row.resultIds.siteId)}</span><span class="entity-meta">Row ${escapeHtml(row.rowNumber)}</span></a></li>`,
    )
    .join("")}</ul></div>`;
}

function newProviderView() {
  const inSiteFlow =
    new URLSearchParams(window.location.search).get("returnTo") === "site-new";
  return `<section class="creation-page" aria-labelledby="new-provider-title">
    <a href="${inSiteFlow ? "/sites/new" : "/providers"}" data-route class="site-back-link"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${inSiteFlow ? "Add new site" : "Providers"}</a>
    <div><h1 id="new-provider-title" tabindex="-1">Add new provider</h1><p class="muted">Create the provider record. ${inSiteFlow ? "You’ll return to the new Site flow afterward." : ""}</p></div>
    <form id="provider-form" class="site-details-form">
      ${formInput("provider-name", "Provider name", "", { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit">Add provider</button>
    </form>
  </section>`;
}

function newProgramView(state) {
  const params = new URLSearchParams(window.location.search);
  const inSiteFlow = params.get("returnTo") === "site-new";
  const inProviderFlow = params.get("returnTo") === "provider";
  const providerId = params.get("providerId") || "";
  return `<section class="creation-page" aria-labelledby="new-program-title">
    <a href="${inSiteFlow ? `/sites/new${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}` : inProviderFlow && providerId ? `/providers/${encodeURIComponent(providerId)}` : "/programs"}" data-route class="site-back-link"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${inSiteFlow ? "Add new site" : inProviderFlow ? "Provider" : escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div><h1 id="new-program-title" tabindex="-1">Add new program</h1><p class="muted">Create the Program and its first staff member. ${inSiteFlow ? "You’ll return to the new Site flow afterward." : inProviderFlow ? "You’ll return to the provider afterward." : ""}</p></div>
    <form id="program-form" class="site-details-form">
      <fieldset><legend>Program</legend><div class="form-grid form-grid--one">
        ${formInput("program-name", "Program name", "", { required: true, autocomplete: "organization" })}
        <wa-select name="program-provider" label="Provider" required data-initial-value="${escapeHtml(providerId)}" placeholder="Choose a provider">
          ${state.providers.map((provider) => `<wa-option value="${escapeHtml(provider.providerId)}" ${provider.providerId === providerId ? "selected" : ""}>${escapeHtml(provider.name)}</wa-option>`).join("")}
        </wa-select>
      </div></fieldset>
      <fieldset><legend>${escapeHtml(t("admin.programs.addStaffMember"))}</legend>
        <wa-select name="program-staff" required disabled aria-label="${escapeHtml(t("admin.programs.addStaffMember"))}" placeholder="${escapeHtml(t("admin.programs.chooseStaff"))}"></wa-select>
        <p class="error" data-staff-error role="alert"></p>
        <button class="btn-outline" type="button" data-retry-staff hidden>${escapeHtml(t("admin.programs.retryStaff"))}</button>
      </fieldset>
      <button class="btn-primary" type="submit" disabled>Add program</button>
    </form>
    <dialog id="new-program-staff-dialog" class="places-modal" aria-labelledby="new-program-staff-title">
      <form class="places-modal__card site-details-form">
        <h2 id="new-program-staff-title">${escapeHtml(t("admin.programs.createStaff"))}</h2>
        <div class="form-grid form-grid--two">
          ${formInput("firstName", t("siteAdmin.field.firstName"), "", { required: true, autocomplete: "given-name" })}
          ${formInput("lastName", t("siteAdmin.field.lastName"), "", { required: true, autocomplete: "family-name" })}
          ${formInput("email", t("siteAdmin.field.email"), "", { required: true, type: "email", autocomplete: "email" })}
          ${phoneInput("phone", t("siteAdmin.field.phone"), "", { type: "tel", autocomplete: "tel" })}
        </div>
        <div class="places-modal__actions">
          <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.createStaff"))}</button>
          <button class="btn-outline" type="button" data-cancel-staff>${escapeHtml(t("common.cancel"))}</button>
        </div>
      </form>
    </dialog>
  </section>`;
}

function newSiteFlowView(state) {
  const params = new URLSearchParams(window.location.search);
  const providerId = params.get("providerId") || "";
  const programId = params.get("programId") || "";
  const provider = state.providers.find(
    (item) => item.providerId === providerId,
  );
  const programs = state.programs.filter(
    (program) =>
      program.status !== "inactive" && program.providerId === providerId,
  );
  const program = programs.find((item) => item.programId === programId);
  const step = !provider ? 1 : !program ? 2 : 3;
  return `<section class="creation-page" aria-labelledby="new-site-title">
    <a href="/sites" data-route class="site-back-link"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div><h1 id="new-site-title" tabindex="-1">Add new site</h1><p class="muted">Step ${step} of 3</p></div>
    <ol class="flow-steps" aria-label="New Site progress">
      <li ${step === 1 ? 'aria-current="step"' : ""}>Provider</li>
      <li ${step === 2 ? 'aria-current="step"' : ""}>Lead Program</li>
      <li ${step === 3 ? 'aria-current="step"' : ""}>Site record</li>
    </ol>
    ${step === 1 ? newSiteProviderStep(state.providers) : ""}
    ${step === 2 ? newSiteProgramStep(provider, programs) : ""}
    ${step === 3 ? newSiteRecordStep(provider, program, state.newSiteUsers) : ""}
  </section>`;
}

function newSiteProviderStep(providers) {
  return `<section class="flow-section" aria-labelledby="provider-step-title">
    <div class="panel__head"><div><h2 id="provider-step-title">Select provider</h2><p class="muted">Choose the provider responsible for this Site.</p></div><a class="btn-link" href="/providers/new?returnTo=site-new" data-route>Add new provider</a></div>
    <form id="new-site-provider-form" class="site-details-form">
      <wa-select name="provider-id" label="Provider" required placeholder="Choose a provider">
        ${providers
          .filter((provider) => provider.status !== "inactive")
          .map(
            (provider) =>
              `<wa-option value="${escapeHtml(provider.providerId)}">${escapeHtml(provider.name)}</wa-option>`,
          )
          .join("")}
      </wa-select>
      <button class="btn-primary" type="submit">Continue</button>
    </form>
  </section>`;
}

function newSiteProgramStep(provider, programs) {
  return `<section class="flow-section" aria-labelledby="program-step-title">
    <p class="muted">Provider: <strong>${escapeHtml(provider.name)}</strong> · <a href="/sites/new" data-route>Change</a></p>
    <div class="panel__head"><div><h2 id="program-step-title">Select lead Program</h2><p class="muted">Choose the Program that leads this Site.</p></div><a class="btn-link" href="/programs/new?returnTo=site-new&providerId=${encodeURIComponent(provider.providerId)}" data-route>Add new program</a></div>
    <form id="new-site-program-form" class="site-details-form">
      <input type="hidden" name="provider-id" value="${escapeHtml(provider.providerId)}" />
      <wa-select name="program-id" label="Lead Program" required placeholder="Choose a Program">
        ${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}">${escapeHtml(program.name)}</wa-option>`).join("")}
      </wa-select>
      ${programs.length ? "" : '<p class="muted">This provider has no Programs yet. Add one to continue.</p>'}
      <button class="btn-primary" type="submit" ${programs.length ? "" : "disabled"}>Continue</button>
    </form>
  </section>`;
}

function newSiteRecordStep(provider, program, users) {
  return `<section class="flow-section" aria-labelledby="record-step-title">
    <p class="muted">Provider: <strong>${escapeHtml(provider.name)}</strong> · Lead Program: <strong>${escapeHtml(program.name)}</strong> · <a href="/sites/new?providerId=${encodeURIComponent(provider.providerId)}" data-route>Change</a></p>
    <div><h2 id="record-step-title">Create Site record</h2><p class="muted">Complete every required field. Required empty fields are marked below.</p></div>
    <form id="new-site-record-form" class="site-details-form new-record-form">
      <input type="hidden" name="provider-id" value="${escapeHtml(provider.providerId)}" />
      <input type="hidden" name="lead-program-id" value="${escapeHtml(program.programId)}" />
      <fieldset><legend>Site details</legend><div class="form-grid form-grid--one">
        ${requiredFlowInput("site-name", "Site name", { autocomplete: "organization" })}
        ${siteTypeSelect("")}
      </div></fieldset>
      <fieldset><legend>Address</legend>
        ${addressEditor({}, { required: true })}
      </fieldset>
      <fieldset><legend>Lead Program manager</legend>
        <wa-select class="required-flow-field" name="site-manager-user-id" required data-empty placeholder="Choose a staff member"><span slot="label">Program staff <em>Required</em></span>
          ${users.map((user) => `<wa-option value="${escapeHtml(user.userId)}">${escapeHtml(`${user.firstName} ${user.lastName}`)}</wa-option>`).join("")}
        </wa-select>
        ${users.length ? "" : `<p class="error">This Program has no active staff. <a href="/programs/${encodeURIComponent(program.programId)}" data-route>Add Program staff</a> before creating the Site.</p>`}
      </fieldset>
      <fieldset><legend>Public site contact</legend><div class="form-grid form-grid--two">
        ${requiredFlowInput("public-contact-email", "Email", { type: "email", autocomplete: "email" })}
        ${phoneExtensionField(requiredFlowInput("public-contact-phone", "Phone", { type: "tel", autocomplete: "tel", pattern: "[0-9()+ .-]{10,20}" }), formInput("public-contact-extension", t("admin.phone.extension"), "", { autocomplete: "tel-extension", maxlength: 20 }), escapeHtml(t("admin.phone.addExtension")), false, escapeHtml(t("admin.phone.removeExtension")))}
      </div></fieldset>
      <button class="btn-primary" type="submit" data-address-dependent ${users.length ? "disabled" : "disabled data-address-blocked"}>Create Site</button>
    </form>
  </section>`;
}

function requiredFlowInput(name, label, options = {}) {
  return `<wa-input class="required-flow-field" name="${escapeHtml(name)}" required data-empty type="${escapeHtml(options.type || "text")}" ${options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : ""} ${options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : ""} ${options.maxlength ? `maxlength="${escapeHtml(options.maxlength)}"` : ""}><span slot="label">${escapeHtml(label)} <em>Required</em></span></wa-input>`;
}

/** @param {AdminState} state */
/** @param {AdminProvider[]} providers */
function providerDirectory(providers) {
  const active = providers
    .filter((provider) => provider.status !== "inactive")
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<section class="site-directory" aria-labelledby="providers-title">
    <div class="panel__head">
      <div><h2 class="visually-hidden" id="providers-title">Providers &amp; Programs</h2>
      <p class="muted">Open a provider to see its associated programs</p>
      <p class="muted">${active.length} ${active.length === 1 ? "provider" : "providers"}</p></div>
      <a class="btn-link" href="/providers/new" data-route>Add new provider</a>
    </div>
    ${active.length ? `<ul class="site-directory-list">${active.map((provider) => `<li><a class="site-directory-row" href="/providers/${encodeURIComponent(provider.providerId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(provider.name)}</strong><span>Provider</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : '<p class="empty-state">No providers have been added.</p>'}
  </section>`;
}

/**
 * @param {any[]} items
 * @param {(item: any) => string} href
 * @param {(item: any) => string} title
 * @param {(item: any) => string} detail
 * @param {string} emptyMessage
 */
function entityList(items, href, title, detail, emptyMessage) {
  if (!items.length)
    return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
  return `<ul class="entity-list">${items
    .map(
      (item) => `<li><a class="entity-link" href="${href(item)}" data-route>
        <span>${escapeHtml(title(item))}</span>
        <span class="entity-meta">${escapeHtml(detail(item))}</span>
      </a></li>`,
    )
    .join("")}</ul>`;
}

/** @param {AdminState} state @param {any | null} manager */
function siteManagerEditorView(state, manager) {
  const isNew = !manager;
  const returnSite =
    new URLSearchParams(window.location.search).get("returnSite") || "";
  const canManageAssignments = state.capabilities.createEntities === true;
  const assignmentDisabled = canManageAssignments ? "" : "disabled";
  const programId = manager?.primaryProgramId ?? manager?.programId ?? "";
  const assigned = new Set(
    (manager?.assignedSites || []).map((site) => site.siteId),
  );
  const programs = state.programs
    .filter((program) => program.status !== "inactive")
    .sort((a, b) => a.name.localeCompare(b.name));
  const sites = state.sites
    .filter((site) => site.status !== "inactive")
    .sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  const title = isNew
    ? "Add new manager"
    : `${manager.firstName} ${manager.lastName}`.trim();
  return `<section class="site-page manager-record" aria-labelledby="manager-record-title">
    ${isNew ? `<a class="site-back-link" href="${returnSite ? `/sites/${encodeURIComponent(returnSite)}?section=details` : "/managers"}" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("common.back"))}</a>` : ""}
    ${entityBreadcrumb("manager", manager || {}, state.programs, state.providers)}
    <div class="panel__head">
      <h1 id="manager-record-title" tabindex="-1">${escapeHtml(title)}</h1>
      ${isNew || manager?.personId ? "" : `<button class="btn-danger" type="button" data-remove-site-manager>${escapeHtml(t("admin.managers.deleteRecord"))}</button>`}
    </div>
    <form id="site-manager-record-form" class="site-details-form" data-read-only="${!canEditSiteManager(state)}" data-dirty-form data-return-site="${escapeHtml(returnSite)}">
      <fieldset>
        <legend>Manager details</legend>
        <wa-select name="manager-program-id" label="${escapeHtml(t("admin.relationships.primaryProgram"))}" placeholder="${escapeHtml(t("admin.relationships.none"))}" ${assignmentDisabled}><wa-option value="" ${programId ? "" : "selected"}>${escapeHtml(t("admin.relationships.none"))}</wa-option>${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}" ${program.programId === programId ? "selected" : ""}>${escapeHtml(program.name)}</wa-option>`).join("")}</wa-select>
        <wa-select name="manager-provider-id" label="${escapeHtml(t("admin.relationships.primaryProvider"))}" ${assignmentDisabled}><wa-option value="" ${manager?.primaryProviderId ? "" : "selected"}>${escapeHtml(t("admin.relationships.none"))}</wa-option>${state.providers
          .filter((p) => p.status !== "inactive")
          .map(
            (p) =>
              `<wa-option value="${escapeHtml(p.providerId)}" ${p.providerId === manager?.primaryProviderId ? "selected" : ""}>${escapeHtml(p.name)}</wa-option>`,
          )
          .join("")}</wa-select>
        <p class="field-help">${escapeHtml(t("admin.relationships.affiliationHelp"))}</p>
        <div class="form-grid form-grid--one">
          ${formInput("manager-first-name", "First name", manager?.firstName || "", { required: true, autocomplete: "given-name" })}
          ${formInput("manager-last-name", "Last name", manager?.lastName || "", { required: true, autocomplete: "family-name" })}
          ${phoneInput("manager-phone", "Contact phone", manager?.phone || "", { extension: manager?.phoneExtension, extensionName: "manager-phone-extension", required: !manager || Boolean(manager.phone), type: "tel", autocomplete: "tel" })}
          ${formInput("manager-email", "Contact email", manager?.email || "", { required: true, type: "email", autocomplete: "email", disabled: !canManageAssignments })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Assigned sites</legend>
        <p class="muted">${escapeHtml(t("admin.relationships.assignmentHelp"))}</p>
        <div class="manager-site-options">
          ${sites
            .map((site) => {
              const matches = true;
              return `<label class="manager-site-option" data-manager-site-program="${escapeHtml(site.leadProgramId || "")}" ${matches ? "" : "hidden"}><wa-checkbox name="manager-site-id" value="${escapeHtml(site.siteId)}" ${assigned.has(site.siteId) ? "checked" : ""} ${matches && canManageAssignments ? "" : "disabled"}>${escapeHtml(siteLabel(site))}</wa-checkbox></label>`;
            })
            .join("")}
          <p class="empty-state" data-manager-sites-empty ${sites.length ? "hidden" : ""}>${escapeHtml(t("admin.relationships.noSites"))}</p>
        </div>
      </fieldset>
      ${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
      <div class="row">
        <button class="btn-primary" type="submit" data-save-button disabled>${isNew ? "Add manager" : "Save changes"}</button>
        ${returnSite ? `<a class="btn-secondary" href="/sites/${encodeURIComponent(returnSite)}?section=details" data-route>${escapeHtml(t("common.cancel"))}</a>` : ""}
      </div>
    </form>
    ${
      isNew
        ? ""
        : `<section class="subsection" aria-labelledby="manager-device-revocation-title">
      <h2 id="manager-device-revocation-title">${escapeHtml(t("admin.devices.removeAllSites"))}</h2>
      <p>${escapeHtml(t("admin.devices.managerRevokeHelp"))}</p>
      <form id="revoke-manager-devices" class="inline-form destructive-confirmation">
        <wa-input name="confirmation" type="email" required autocomplete="off" label="${escapeHtml(t("admin.devices.confirmEmail", { email: manager.email }))}"></wa-input>
        <button class="btn-danger" type="submit" disabled>${escapeHtml(t("admin.devices.removeAllSites"))}</button>
        <p data-revocation-status role="status"></p>
      </form>
    </section>`
    }
    ${isNew ? "" : `${managerProgramChangeDialog()}${removeSiteManagerDialog(title)}`}
    ${discardChangesDialog()}
  </section>`;
}

function siteLabel(site) {
  return site.name || site.siteName || site.siteId || "Site";
}

/** @param {"site" | "program" | "provider" | "manager"} kind @param {any} record @param {any[]} programs @param {any[]} providers */
function entityBreadcrumb(kind, record, programs = [], providers = []) {
  const program =
    kind === "site" || kind === "manager"
      ? programs.find(
          (item) =>
            item.programId ===
            (kind === "site" ? record.leadProgramId : record.programId),
        )
      : record;
  const providerId = record.providerId || program?.providerId;
  const providerName =
    record.providerName ||
    program?.providerName ||
    providers.find((item) => item.providerId === providerId)?.name;
  const parents = [];
  if (kind !== "provider" && providerId)
    parents.push({
      href: `/providers/${encodeURIComponent(providerId)}`,
      label: providerName || t("admin.breadcrumb.provider"),
    });
  const parentProgramId =
    kind === "site"
      ? record.leadProgramId
      : kind === "manager"
        ? record.programId
        : "";
  if (parentProgramId)
    parents.push({
      href: `/programs/${encodeURIComponent(parentProgramId)}`,
      label:
        record.programName || program?.name || t("admin.breadcrumb.program"),
    });
  const root =
    kind === "provider"
      ? "/providers"
      : kind === "program"
        ? "/programs"
        : kind === "manager"
          ? "/managers"
          : "/sites";
  return `<nav class="entity-breadcrumb" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}"><ol>
    <li><a href="${root}" data-route>${escapeHtml(t("admin.breadcrumb.admin"))}</a></li>
    ${parents.map((parent) => `<li class="entity-breadcrumb__parent"><span aria-hidden="true">›</span><a href="${parent.href}" data-route>${escapeHtml(parent.label)}</a></li>`).join("")}
    <li><span aria-hidden="true">›</span><span aria-current="page">${escapeHtml(t(`admin.breadcrumb.${kind}`))}</span></li>
  </ol></nav>`;
}

/** @param {AdminState} state */
function providerView(state) {
  const provider = /** @type {AdminProvider} */ (state.provider);
  const linkedPrograms = state.programs
    .filter(
      (program) =>
        program.status !== "inactive" &&
        program.providerId === provider.providerId,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const availablePrograms = state.programs
    .filter(
      (program) =>
        program.status !== "inactive" &&
        program.providerId !== provider.providerId,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const access =
    new URLSearchParams(location.search).get("section") === "access";
  return `<section class="site-page site-record" aria-labelledby="provider-title">
    ${entityBreadcrumb("provider", provider)}
    <div class="panel__head">
      <h1 id="provider-title" tabindex="-1">${escapeHtml(provider.name)}</h1>
    </div>
    <nav class="entity-tabs" aria-label="${escapeHtml(t("admin.providerManagers.providerTabs"))}">
      <a href="/providers/${encodeURIComponent(provider.providerId)}?section=details" data-route ${access ? "" : 'aria-current="page"'}>${escapeHtml(t("admin.providerManagers.providerDetails"))}</a>
      ${state.capabilities.manageProviderManagers ? `<a href="/providers/${encodeURIComponent(provider.providerId)}?section=access" data-route ${access ? 'aria-current="page"' : ""}>${escapeHtml(t("admin.providerManagers.appAccess"))}</a>` : ""}
    </nav>
    ${
      access
        ? state.capabilities.manageProviderManagers
          ? providerAccessView(state)
          : ""
        : `
    <form id="provider-details-form" class="site-details-form" data-dirty-form>
      ${formInput("provider-name", "Provider name", provider.name, { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit" data-save-button disabled>Save changes</button>
    </form>
    ${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    ${state.capabilities.manageProviderManagers ? providerManagerPanel(state) : ""}
    <section class="subsection" aria-labelledby="provider-programs-title">
      <div class="panel__head">
        <h2 id="provider-programs-title">Programs</h2>
        <a class="btn-link" href="/programs/new?providerId=${encodeURIComponent(provider.providerId)}&returnTo=provider" data-route>Create a new program</a>
      </div>
      ${linkedPrograms.length ? `<ul class="site-directory-list">${linkedPrograms.map((program) => `<li><a class="site-directory-row" href="/programs/${encodeURIComponent(program.programId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(program.name)}</strong><span>Program</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : '<p class="empty-state">No programs are linked to this provider.</p>'}
      <form id="provider-program-form" class="inline-form">
        <wa-select name="program-id" label="Add program" required placeholder="Choose a program" ${availablePrograms.length ? "" : "disabled"}>
          ${availablePrograms.map((program) => `<wa-option value="${escapeHtml(program.programId)}">${escapeHtml(program.name)}</wa-option>`).join("")}
        </wa-select>
        <button class="btn-primary" type="submit" data-add-program-button disabled>Add program</button>
      </form>
      ${!availablePrograms.length && linkedPrograms.length ? '<p class="muted">Every active Program is already linked to this provider.</p>' : ""}
    </section>
    ${state.capabilities.createEntities ? `<section class="subsection"><h2>${escapeHtml(t("admin.providerManagers.deactivateProvider"))}</h2><p>${escapeHtml(t("admin.providerManagers.deactivateProviderHelp"))}</p><button class="btn-danger" type="button" data-deactivate-provider="${escapeHtml(provider.providerId)}">${escapeHtml(t("admin.providerManagers.deactivateProvider"))}</button></section>` : ""}
    `
    }
    ${deactivateProviderDialog(provider.name)}
    ${discardChangesDialog()}
  </section>`;
}

/** @param {AdminState} state */
function providerManagerPanel(state) {
  return `<section class="subsection" aria-labelledby="provider-managers-title">
    <div class="panel__head"><h2 id="provider-managers-title">${escapeHtml(t("admin.providerManagers.title"))}</h2><button class="btn-primary" id="add-provider-manager" type="button" aria-haspopup="dialog">${escapeHtml(t("admin.providers.addManager"))}</button></div>
    <p class="muted">${escapeHtml(t("admin.enrollment.providerDefinition"))}</p>
    ${state.providerManagers
      .filter((manager) => manager.status === "active")
      .map((manager) => providerManagerRow(manager, state.provider.providerId))
      .join("")}
    <form class="inline-form" data-assign-existing-provider-person><wa-select name="person-id" label="${escapeHtml(t("admin.relationships.assignExistingPerson"))}" placeholder="${escapeHtml(t("admin.relationships.choosePerson"))}" required>${(
      state.people || []
    )
      .filter(
        (person) =>
          !state.providerManagers.some(
            (m) => m.personId === person.personId && m.status === "active",
          ),
      )
      .map(
        (person) =>
          `<wa-option value="${escapeHtml(person.personId)}">${escapeHtml(person.name)} · ${escapeHtml(person.email)}</wa-option>`,
      )
      .join(
        "",
      )}</wa-select><button class="btn-secondary" type="submit">${escapeHtml(t("admin.relationships.assignPerson"))}</button></form>
    <dialog id="add-provider-manager-dialog" class="places-modal" data-provider-manager-dialog aria-labelledby="add-provider-manager-title">
      <form class="places-modal__card site-details-form" data-provider-manager-form>
        <h2 id="add-provider-manager-title">${escapeHtml(t("admin.providers.addManager"))}</h2>
        <div class="form-grid">
          ${formInput("provider-manager-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
          ${formInput("provider-manager-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
          ${formInput("provider-manager-email", "Email", "", { required: true, type: "email", autocomplete: "email" })}
          ${phoneInput("provider-manager-phone", "Phone", "", { required: true, type: "tel", autocomplete: "tel" })}
        </div>
        <div class="places-modal__actions">
          <button class="btn-primary" type="submit">${escapeHtml(t("admin.providers.addManager"))}</button>
          <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
        </div>
      </form>
    </dialog>
  </section>`;
}

/** @param {any} manager @param {string} providerId */
function providerManagerRow(manager, providerId) {
  const inactive = manager.status === "inactive";
  return `<article class="provider-manager-summary" data-provider-manager-row><div><h3>${escapeHtml(manager.name)}</h3><a href="mailto:${escapeHtml(manager.email)}">${escapeHtml(manager.email)}</a><p class="muted">${escapeHtml(t("admin.providerManagers.deviceCount", { count: manager.activeDeviceCount || 0 }))}${inactive ? ` · ${escapeHtml(t("admin.providerManagers.inactive"))}` : ""}</p></div><div class="row">
    <a class="btn-secondary" href="${providerManagerPath(providerId, manager.membershipId)}" data-route>${escapeHtml(t("common.edit"))}</a>
    <button class="${inactive ? "btn-secondary" : "btn-danger"}" type="button" data-provider-manager-status="${escapeHtml(manager.membershipId)}" data-provider-manager-active="${inactive ? "true" : "false"}">${escapeHtml(t(inactive ? "admin.providerManagers.reinstate" : "admin.siteManagers.remove"))}</button>
  </div></article>`;
}

function providerManagerDirectoryView(state, search = "") {
  const query = search.toLocaleLowerCase();
  const managers = (state.providerManagerDirectory || []).filter((manager) =>
    [manager.firstName, manager.lastName, manager.providerName, manager.email]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  return `<section class="site-directory" aria-labelledby="provider-manager-directory-title"><h2 class="visually-hidden" id="provider-manager-directory-title">${escapeHtml(t("admin.providerManagers.title"))}</h2><p class="muted directory-count">${escapeHtml(t(managers.length === 1 ? "admin.providerManagers.count.one" : "admin.providerManagers.count.other", { count: managers.length }))}</p>${managers.length ? `<ul class="site-directory-list">${managers.map((manager) => `<li><a class="site-directory-row" href="${providerManagerPath(manager.providerId, manager.membershipId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml([manager.firstName, manager.lastName].filter(Boolean).join(" ") || manager.name)}</strong><span>${escapeHtml(manager.status === "inactive" ? t("admin.providerManagers.previousProvider", { name: manager.providerName }) : manager.providerName)}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : `<p class="empty-state">${escapeHtml(t("admin.providerManagers.none"))}</p>`}</section>`;
}

function providerManagerDetailView(state, membershipId) {
  const manager = state.providerManagers.find(
    (item) => item.membershipId === membershipId,
  );
  if (!manager)
    return `<p role="alert">${escapeHtml(t("admin.providerManagers.notFound"))}</p>`;
  return `<section class="site-page site-record"><nav class="entity-breadcrumb" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}"><a href="/provider-managers" data-route>${escapeHtml(t("admin.providerManagers.title"))}</a><span aria-hidden="true"> › </span><a href="/providers/${encodeURIComponent(state.provider.providerId)}?section=details" data-route>${escapeHtml(state.provider.name)}</a></nav>
    <h1 tabindex="-1">${escapeHtml(manager.name)}</h1>
    <form id="provider-manager-record-form" class="site-details-form" data-provider-manager-form data-dirty-form>
      <h2>${escapeHtml(t("admin.providerManagers.details"))}</h2>
      <input type="hidden" name="provider-manager-membership-id" value="${escapeHtml(manager.membershipId)}">
      ${formInput("provider-manager-first-name", t("admin.programs.firstName"), manager.firstName, { required: true, autocomplete: "given-name" })}
      ${formInput("provider-manager-last-name", t("admin.programs.lastName"), manager.lastName, { required: true, autocomplete: "family-name" })}
      ${formInput("provider-manager-email", t("admin.programs.email"), manager.email, { required: true, type: "email", autocomplete: "email" })}
      ${phoneInput("provider-manager-phone", t("admin.programs.phone"), manager.phone, { extension: manager.phoneExtension, required: true, type: "tel", autocomplete: "tel" })}
      <button class="btn-primary" type="submit" data-save-button disabled>${escapeHtml(t("admin.programs.saveStaff"))}</button>
    </form>
    <section class="subsection"><h2>${escapeHtml(t("admin.providerManagers.associatedProvider"))}</h2>${manager.status === "inactive" ? `<p>${escapeHtml(t("admin.providerManagers.noAssignedProvider"))}</p><button class="btn-secondary" type="button" data-provider-manager-status="${escapeHtml(manager.membershipId)}" data-provider-manager-active="true">${escapeHtml(t("admin.providerManagers.reassign", { name: state.provider.name }))}</button>` : `<a href="/providers/${encodeURIComponent(state.provider.providerId)}" data-route>${escapeHtml(state.provider.name)}</a>`}</section>
    ${
      manager.status === "active"
        ? `<section class="subsection"><h2>${escapeHtml(t("admin.relationships.changeProvider"))}</h2><p>${escapeHtml(t("admin.relationships.transferHelp"))}</p><form data-transfer-provider-manager="${escapeHtml(manager.membershipId)}" class="site-details-form"><wa-select name="target-provider" label="${escapeHtml(t("admin.relationships.newProvider"))}" required placeholder="${escapeHtml(t("admin.relationships.chooseProvider"))}">${state.providers
            .filter(
              (p) =>
                p.status !== "inactive" &&
                p.providerId !== state.provider.providerId,
            )
            .map(
              (p) =>
                `<wa-option value="${escapeHtml(p.providerId)}">${escapeHtml(p.name)}</wa-option>`,
            )
            .join(
              "",
            )}</wa-select><wa-input name="confirmation" label="${escapeHtml(t("admin.relationships.confirmTransfer", { name: manager.email }))}" required></wa-input><button class="btn-danger" type="submit">${escapeHtml(t("admin.relationships.changeProvider"))}</button></form></section>`
        : ""
    }
    ${providerDeviceRemovalForm(state, manager)}
    ${discardChangesDialog()}
  </section>`;
}

function providerEmailActions(manager) {
  return `<div class="contact-list__actions"><button class="btn-secondary" type="button" data-issue-provider-manager-grant="${escapeHtml(manager.membershipId)}" data-delivery-mode="link">${escapeHtml(t("admin.enrollment.emailMagicLink"))}</button><button class="btn-secondary" type="button" data-issue-provider-manager-grant="${escapeHtml(manager.membershipId)}" data-delivery-mode="code">${escapeHtml(t("admin.enrollment.emailOneTimeCode"))}</button></div>`;
}

function providerAccessView(state) {
  const active = state.providerManagers.filter(
    (manager) => manager.status === "active",
  );
  return `<section><h2>${escapeHtml(t("admin.providerManagers.accessTitle"))}</h2><p>${escapeHtml(t("admin.providerManagers.accessInstructions"))}</p>${active.length ? `<ul class="contact-list provider-access-managers">${active.map((manager) => `<li><div><strong>${escapeHtml(manager.name)}</strong><span>${escapeHtml(manager.email)}</span>${state.providerManagerGrantErrors?.[manager.membershipId] ? `<p class="error" role="alert" data-provider-manager-grant-error="${escapeHtml(manager.membershipId)}">${escapeHtml(state.providerManagerGrantErrors[manager.membershipId])}</p>` : ""}</div>${providerEmailActions(manager)}</li>`).join("")}</ul>` : `<p class="empty-state">${escapeHtml(t("admin.providerManagers.none"))}</p>`}</section>
    <section class="subsection">${providerManagerGrantList(state.providerManagerGrants)}</section>
    <section class="subsection"><h2>${escapeHtml(t("admin.enrollment.enrolledDevices"))}</h2>${providerManagerEnrollmentList(state.providerManagerEnrollments, state.providerManagers)}</section>
    ${providerDeviceRemovalForm(state)}
  `;
}

function providerDeviceRemovalForm(state, manager = null) {
  const confirmation = manager ? manager.email : state.provider.name;
  return `<section class="subsection"><h2>${escapeHtml(t(manager ? "admin.providerManagers.removeAccess" : "admin.providerManagers.removeAllAccess"))}</h2><p>${escapeHtml(t(manager ? "admin.providerManagers.unlinkHelp" : "admin.providerManagers.removeAccessHelp"))}</p><form class="inline-form destructive-confirmation" data-revoke-provider-devices data-membership-id="${escapeHtml(manager?.membershipId || "")}" data-confirmation="${escapeHtml(confirmation)}">
    <wa-input name="confirmation" required autocomplete="off" label="${escapeHtml(t(manager ? "admin.providerManagers.confirmManager" : "admin.providerManagers.confirmProvider", { name: confirmation }))}"></wa-input><button class="btn-danger" type="submit" disabled>${escapeHtml(t("admin.providerManagers.removeAccess"))}</button>
  </form></section>`;
}

/** @param {any[]} grants */
function providerManagerGrantList(grants) {
  if (!grants.length) {
    return `<h2>${escapeHtml(t("admin.enrollment.history", { count: 0 }))}</h2>`;
  }
  return `<details class="table-disclosure"><summary>${escapeHtml(t("admin.enrollment.history", { count: grants.length }))}</summary><div class="table-wrap"><table class="provider-enrollment-history"><thead><tr><th>Recipient</th><th>${escapeHtml(t("admin.enrollment.type"))}</th><th>Sites</th><th>Issued</th><th>Expires</th><th>Status</th><th>Delivery</th><th>Action</th></tr></thead><tbody>${grants
    .map(
      (grant) =>
        `<tr><td><span class="enrollment-recipient"><span>${escapeHtml(grant.issuedTo)}</span>${grant.enrollmentUrl ? `<button class="btn-icon enrollment-copy" type="button" title="Copy enrollment link" aria-label="Copy provider enrollment link for ${escapeHtml(grant.issuedTo)}" data-copy-enrollment-url="${escapeHtml(grant.enrollmentUrl)}"><wa-icon name="copy" aria-hidden="true"></wa-icon></button><span class="visually-hidden" aria-live="polite" data-copy-status></span>` : ""}</span></td><td>${escapeHtml(t(grant.deliveryMode === "code" ? "admin.enrollment.oneTimeCode" : "admin.enrollment.magicLink"))}</td><td>${escapeHtml(grant.siteCount || 0)}</td><td>${escapeHtml(formatTimestamp(grant.createdAt))}</td><td>${escapeHtml(formatTimestamp(grant.expiresAt))}</td><td>${escapeHtml(grant.status)}</td><td>${escapeHtml(grant.deliveryStatus || "queued")}</td><td>${grant.status === "pending" ? `<button class="btn-danger" type="button" data-cancel-provider-manager-grant="${escapeHtml(grant.grantId)}">Cancel</button>` : "—"}</td></tr>`,
    )
    .join("")}</tbody></table></div></details>`;
}

function providerManagerEnrollmentList(enrollments, managers) {
  const active = enrollments.filter((item) => item.status !== "revoked");
  if (!active.length)
    return `<p class="empty-state">${escapeHtml(t("admin.providerManagers.noDevices"))}</p>`;
  const names = new Map(
    managers.map((manager) => [manager.membershipId, manager.name]),
  );
  return `<div class="table-wrap"><table><thead><tr><th>Provider Manager</th><th>Device</th><th>Sites</th><th>Enrolled</th><th>Action</th></tr></thead><tbody>${active
    .map(
      (enrollment) =>
        `<tr><td>${escapeHtml(names.get(enrollment.membershipId) || "Provider Manager")}</td><td>ID ${escapeHtml(shortOpaqueId(enrollment.physicalDeviceId))}</td><td>${escapeHtml(enrollment.activeSiteCount ?? enrollment.siteCount ?? 0)} of ${escapeHtml(enrollment.siteCount || 0)} active</td><td>${escapeHtml(formatTimestamp(enrollment.createdAt))}</td><td><button class="btn-danger" type="button" data-revoke-provider-enrollment="${escapeHtml(enrollment.enrollmentId)}">Revoke device</button></td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

/** @param {string} providerName */
function deactivateProviderDialog(providerName) {
  return `<dialog id="deactivate-provider-dialog" class="places-modal" aria-labelledby="deactivate-provider-title" aria-describedby="deactivate-provider-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="deactivate-provider-title">Deactivate ${escapeHtml(providerName)}?</h2>
        <p class="places-modal__text" id="deactivate-provider-copy">This will remove the provider from the active Providers &amp; Programs list. Its programs, sites, and app access will not be changed.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Deactivate provider</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {any} program */
function programView(program, canAddStaff = false) {
  const primaryId = primaryProgramStaffId(program);
  const staff = (program.users || [])
    .filter((user) => user.status !== "inactive")
    .sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      ),
    );
  return `<section class="site-page">
    ${entityBreadcrumb("program", program)}
    <div class="panel__head">
      <div>
        <h1 tabindex="-1">${escapeHtml(program.name)}</h1>
      </div>
      ${program.needsReview ? '<span class="status-badge">Needs review</span>' : '<span class="status-badge">Active</span>'}
    </div>
    <section aria-labelledby="program-sites-title">
      <h2 id="program-sites-title">Sites</h2>
      ${entityList(
        program.sites || [],
        (site) => `/sites/${encodeURIComponent(site.siteId)}`,
        (site) => site.siteName || site.name || site.siteId,
        (site) => site.status || "Active",
        "No sites are assigned to this program.",
      )}
    </section>
    <section class="subsection" aria-labelledby="program-staff-title">
      <div class="panel__head">
        <h2 id="program-staff-title">${escapeHtml(t("admin.programs.staff"))}</h2>
        ${canAddStaff ? `<button class="btn-primary" id="add-program-staff" type="button">${escapeHtml(t("admin.programs.addStaffMember"))}</button>` : ""}
      </div>
      ${
        staff.length
          ? `<ul class="site-directory-list">${staff
              .map(
                (
                  user,
                ) => `<li class="site-directory-row"><div class="site-directory-row__text">
        <span><strong>${escapeHtml(`${user.firstName || ""} ${user.lastName || ""}`.trim())}</strong>${user.userId === primaryId ? ` - <em>${escapeHtml(t("admin.programs.primaryContactInline"))}</em>` : ""}</span>
        <span>${escapeHtml(user.email || "")}</span>
        <span>${escapeHtml(phoneWithExtension(user))}</span>
        <span>${escapeHtml(t("admin.programs.assignedSites"))} ${user.assignedSites?.length ? user.assignedSites.map((site) => `<a href="/sites/${encodeURIComponent(site.siteId)}" data-route>${escapeHtml(siteLabel(site))}</a>`).join(", ") : escapeHtml(t(user.assignmentSitesUnavailable?.length ? "admin.programs.assignmentsUnavailable" : "admin.programs.noAssignedSites"))}${user.assignedSites?.length && user.assignmentSitesUnavailable?.length ? ` · ${escapeHtml(t("admin.programs.assignmentsUnavailable"))}` : ""}</span>
      </div><button class="btn-secondary" type="button" data-edit-program-staff="${escapeHtml(user.userId)}" aria-label="${escapeHtml(t("admin.programs.editStaffNamed", { name: `${user.firstName} ${user.lastName}` }))}">${escapeHtml(t("admin.programs.editStaff"))}</button></li>`,
              )
              .join("")}</ul>`
          : `<p class="empty-state">${escapeHtml(t("admin.programs.noStaff"))}</p>`
      }
    </section>
    ${canAddStaff ? programStaffDialog() : ""}
    ${staff.map((user) => programStaffEditDialog(user, user.userId === primaryId, canAddStaff)).join("")}
  </section>`;
}

function programStaffEditDialog(user, primary, canEditEmail = false) {
  return `<dialog id="edit-program-staff-${escapeHtml(user.userId)}" class="places-modal program-staff-edit-dialog" aria-labelledby="edit-staff-title-${escapeHtml(user.userId)}">
    <form data-program-staff-edit-form="${escapeHtml(user.userId)}" class="places-modal__card site-details-form">
      <h2 id="edit-staff-title-${escapeHtml(user.userId)}">${escapeHtml(t("admin.programs.editStaff"))}</h2>
      ${formInput("staff-first-name", t("admin.programs.firstName"), user.firstName, { required: true, autocomplete: "given-name" })}
      ${formInput("staff-last-name", t("admin.programs.lastName"), user.lastName, { required: true, autocomplete: "family-name" })}
      ${phoneInput("staff-phone", t("admin.programs.phone"), user.phone, { extension: user.phoneExtension, required: Boolean(user.phone), type: "tel", autocomplete: "tel" })}
      ${formInput("staff-email", t("admin.programs.email"), user.email, { required: true, type: "email", autocomplete: "email", disabled: !canEditEmail })}
      <wa-checkbox name="staff-primary-contact" ${canEditEmail ? "" : "disabled"} ${primary ? "checked" : ""}>${escapeHtml(t("admin.programs.primaryContact"))}</wa-checkbox>
      <p class="muted">${escapeHtml(t("admin.programs.primaryHelp"))}</p>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.saveStaff"))}</button>
        <button class="btn-outline" type="button" data-cancel-program-staff-edit>${escapeHtml(t("admin.programs.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

function programStaffDialog() {
  return `<dialog id="add-program-staff-dialog" class="places-modal" aria-labelledby="add-program-staff-title">
    <form id="program-staff-form" class="places-modal__card site-details-form">
      <h2 id="add-program-staff-title">${escapeHtml(t("admin.programs.addStaffMember"))}</h2>
      ${formInput("staff-first-name", t("admin.programs.firstName"), "", { required: true, autocomplete: "given-name" })}
      ${formInput("staff-last-name", t("admin.programs.lastName"), "", { required: true, autocomplete: "family-name" })}
      ${phoneInput("staff-phone", t("admin.programs.phone"), "", { required: true, type: "tel", autocomplete: "tel" })}
      ${formInput("staff-email", t("admin.programs.email"), "", { required: true, type: "email", autocomplete: "email" })}
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.addStaffMember"))}</button>
        <button class="btn-outline" id="cancel-program-staff" type="button">${escapeHtml(t("admin.programs.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

function siteTypeSelect(value) {
  const options = [
    ["", "Not set"],
    ["permanent_supportive_housing", "Permanent supportive housing"],
    ["shelter", "Shelter"],
    ["drop_in", "Drop-in"],
  ];
  return `<wa-select name="site-type" label="Site type">
    ${options.map(([optionValue, label]) => `<wa-option value="${optionValue}" ${optionValue === value ? "selected" : ""}>${label}</wa-option>`).join("")}
  </wa-select>`;
}

/**
 * @param {AdminSite} site
 * @param {boolean} saving
 * @param {string} saveError
 */
function siteEditor(state) {
  const site = /** @type {AdminSite} */ (state.site);
  const address = site.addressParts || parseLegacyAddress(site.address) || {};
  const publicContact = site.publicContact || site.contactPerson || {};
  const programs = siteProviderPrograms(state.programs, site.providerId);
  const hasAddress = Boolean(site.address || streetLineFromParts(address));
  return `<form id="site-details-form" class="site-details-form" data-read-only="${!canEditSite(state)}" data-dirty-form>
    <fieldset>
      <legend>Site name and public contact</legend>
      <div class="form-grid form-grid--one" data-site-details-fields>
        ${formInput("site-name", "Site name", site.name, { required: true, autocomplete: "organization" })}
        ${siteTypeSelect(site.siteType || "")}
        <div class="form-grid form-grid--two">
          ${formInput("public-contact-email", "Public contact email", publicContact.email, { type: "email", autocomplete: "email" })}
          ${phoneInput("public-contact-phone", "Public contact phone", publicContact.phone, { extension: publicContact.phoneExtension, type: "tel", autocomplete: "tel", pattern: "(?:\\+?1[ .-]?)?\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}" })}
        </div>
        <button class="btn-primary" type="submit" data-save-site-details disabled>${state.siteSaving ? "Saving…" : "Save changes"}</button>
      </div>
    </fieldset>
    <fieldset>
      <legend>Address</legend>
      <div data-address-container>
        ${
          hasAddress
            ? `<div class="address-display">
                <p data-address-display>${escapeHtml(site.address || formatAddressParts(address))}</p>
                <button class="btn-secondary" type="button" data-edit-address aria-controls="site-address-editor" aria-expanded="false">Edit address</button>
              </div>
              <div id="site-address-editor" data-address-editor hidden>
                ${addressEditor(address)}
                <button class="btn-primary" type="button" data-save-address disabled>Save address</button>
              </div>`
            : `<div data-address-editor>
                ${addressEditor(address)}
                <button class="btn-primary" type="button" data-save-address disabled>Save address</button>
              </div>`
        }
      </div>
    </fieldset>
    <fieldset>
      <legend>${escapeHtml(t("admin.relationships.siteAffiliations"))}</legend>
      <div class="form-grid form-grid--one">
        <wa-select name="lead-provider-id" label="${escapeHtml(t("admin.relationships.leadProvider"))}" data-initial-value="${escapeHtml(site.providerId)}">${state.providers
          .filter((p) => p.status !== "inactive")
          .map(
            (p) =>
              `<wa-option value="${escapeHtml(p.providerId)}" ${p.providerId === site.providerId ? "selected" : ""}>${escapeHtml(p.name)}</wa-option>`,
          )
          .join("")}</wa-select>
        <wa-select name="lead-program-id" aria-label="Lead program" placeholder="No lead program assigned" data-initial-value="${escapeHtml(site.leadProgramId || "")}">
          <wa-option value="" ${site.leadProgramId ? "" : "selected"}>No lead program assigned</wa-option>
          ${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}" ${program.programId === site.leadProgramId ? "selected" : ""}>${escapeHtml(program.name)}</wa-option>`).join("")}
          ${state.capabilities.createEntities && site.providerId ? `<wa-option value="__create_program__" data-create-program>${escapeHtml(t("admin.programs.createNew"))}</wa-option>` : ""}
        </wa-select>
        <button class="btn-primary" type="button" data-save-lead-program disabled>${escapeHtml(t("admin.relationships.saveAffiliations"))}</button>
      </div>
    </fieldset>
    ${state.siteSaveError ? `<p id="site-save-error" class="error site-details-form__message" role="alert">${escapeHtml(state.siteSaveError)}</p>` : ""}
  </form>
  ${siteManagersEditorView(state)}
  ${leadProgramConfirmationDialog()}
  ${state.capabilities.createEntities && site.providerId ? createSiteProgramDialog() : ""}
  `;
}

function createSiteProgramDialog() {
  return `<dialog id="create-site-program-dialog" class="places-modal" aria-labelledby="create-site-program-title">
    <form class="places-modal__card site-details-form">
      <h2 id="create-site-program-title">${escapeHtml(t("admin.programs.createNew"))}</h2>
      ${formInput("program-name", t("admin.programs.name"), "", { required: true, autocomplete: "organization" })}
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.createNew"))}</button>
        <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

function leadProgramConfirmationDialog() {
  return `<dialog id="lead-program-confirmation-dialog" class="places-modal" aria-labelledby="lead-program-confirmation-title" aria-describedby="lead-program-confirmation-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="lead-program-confirmation-title">${escapeHtml(t("admin.relationships.confirmSiteChange"))}</h2>
        <p class="places-modal__text" id="lead-program-confirmation-copy">${escapeHtml(t("admin.relationships.siteChangeHelp"))}</p><p data-reassignment-preview></p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" value="confirm">${escapeHtml(t("admin.relationships.saveAffiliations"))}</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function siteManagerContactDetails(user) {
  if (!user) return "";
  return `<p class="muted">${escapeHtml(user.email || "No email")} · ${escapeHtml(phoneWithExtension(user) || "No phone")}</p>`;
}

function phoneWithExtension(contact) {
  const phone = String(contact?.phone || "");
  const extension = String(contact?.phoneExtension || "");
  return extension ? `${phone} ext. ${extension}` : phone;
}

function parseLegacyAddress(value) {
  const match =
    /^\s*([^,]+),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/.exec(
      String(value || ""),
    );
  if (!match) return null;
  const street = /^(\S+)\s+(.+)$/.exec(match[1].trim());
  if (!street) return null;
  return {
    streetNumber: street[1],
    streetAddress: street[2],
    secondLine: "",
    city: match[2].trim(),
    state: match[3].toUpperCase(),
    zip: match[4],
  };
}

function addressEditor(address, options = {}) {
  const required = Boolean(options.required);
  const line = streetLineFromParts(address);
  const formatted = formatAddressParts(address);
  return `<div class="address-editor">
    <div class="address-lookup" data-address-lookup>
      <wa-input class="address-search" type="search" pill with-clear label="Search for an address" name="address-query" value="${escapeHtml(formatted)}" placeholder="Start typing a street address" autocomplete="off" inputmode="search" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="address-suggestions" data-address-query ${required ? "required data-empty" : ""}>
        <wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon>
      </wa-input>
      <ul class="address-suggestions" id="address-suggestions" data-address-results></ul>
      <p class="visually-hidden" aria-live="polite" data-address-status></p>
      <button class="btn-neutral-filled address-manual" type="button" aria-controls="manual-address-fields" aria-expanded="false" data-enter-address-manually>Enter address manually</button>
      <p class="field-help">Address suggestions powered by <a href="https://photon.komoot.io/" target="_blank" rel="noopener noreferrer">Photon</a> and © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>.</p>
    </div>
    <div class="form-grid form-grid--one address-fields" id="manual-address-fields" data-address-fields hidden>
      ${addressField("street-address", "Street address", line, { autocomplete: "street-address", required, disabled: true })}
      ${addressField("city", "City", address.city || "", { autocomplete: "address-level2", required, disabled: true })}
      ${addressField("state", "State", address.state || "", { autocomplete: "address-level1", maxlength: 2, required, disabled: true })}
      ${addressField("zip", "ZIP", address.zip || "", { autocomplete: "postal-code", pattern: "[0-9]{5}(-[0-9]{4})?", required, disabled: true })}
    </div>
  </div>`;
}

/**
 * @param {string} name
 * @param {string} label
 * @param {unknown} value
 * @param {{ autocomplete?: string, pattern?: string, maxlength?: number, required?: boolean, disabled?: boolean }} [options]
 */
function addressField(name, label, value, options = {}) {
  const required = Boolean(options.required);
  return `<wa-input class="${required ? "required-flow-field" : ""}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : ""} ${options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : ""} ${options.maxlength ? `maxlength="${escapeHtml(options.maxlength)}"` : ""} ${required ? "required data-empty" : "required"} ${options.disabled ? "disabled" : ""}><span slot="label">${escapeHtml(label)}${required ? " <em>Required</em>" : ""}</span></wa-input>`;
}

function addressPartsFromForm(data) {
  const streetLine = formValue(data, "street-address");
  const match = /^(\S+)\s+(.+)$/.exec(streetLine);
  return {
    streetNumber: match?.[1] || "",
    streetAddress: match?.[2] || "",
    secondLine: "",
    city: formValue(data, "city"),
    state: formValue(data, "state").toUpperCase(),
    zip: formValue(data, "zip"),
  };
}

function streetLineFromParts(address) {
  return [address.streetNumber, address.streetAddress, address.secondLine]
    .filter(Boolean)
    .join(" ");
}

function formatAddressParts(address) {
  const street = streetLineFromParts(address);
  const region = [address.state, address.zip].filter(Boolean).join(" ");
  const locality = [address.city, region].filter(Boolean).join(", ");
  return [street, locality].filter(Boolean).join(", ");
}

function uniqueNamedOptions(items) {
  return [
    ...new Map(
      items.filter((item) => item?.name).map((item) => [item.name, item]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

function oversightCreationDialogs(state) {
  const departments = uniqueNamedOptions(state.oversightOptions.departments);
  const assignedManagerIds = new Set(
    state.assignedComplianceManagers.map((manager) => manager.managerId),
  );
  const candidates = state.programManagers.filter(
    (manager) => !assignedManagerIds.has(manager.userId),
  );
  return `<dialog id="choose-compliance-manager-dialog" class="places-modal" aria-labelledby="choose-compliance-manager-title">
    <div class="places-modal__card compliance-manager-picker">
      <header class="compliance-manager-picker__header">
        <h2 id="choose-compliance-manager-title">${escapeHtml(t("admin.oversight.addCityProgramManager"))}</h2>
        <button class="btn-icon" type="button" data-close-dialog aria-label="Close add program manager dialog"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
      </header>
      <wa-input id="compliance-manager-search" type="search" label="${escapeHtml(t("admin.oversight.searchExistingManagers"))}" placeholder="Search by name, email, or department" autocomplete="off" with-clear></wa-input>
      <p class="visually-hidden" aria-live="polite" data-manager-search-status>Search by name, email, or department to find a program manager.</p>
      <h3 class="compliance-manager-candidates__title" data-manager-results-heading hidden>Search results</h3>
      <ul class="compliance-manager-candidates">
        ${candidates.map((manager) => `<li hidden><button class="compliance-manager-candidate" type="button" data-select-compliance-manager data-manager-id="${escapeHtml(manager.userId)}" data-search-text="${escapeHtml([manager.name, manager.email, manager.departmentName].filter(Boolean).join(" ").toLocaleLowerCase("en-US"))}"><span><strong>${escapeHtml(manager.name)}</strong><span>${escapeHtml(manager.email || "No email")}</span></span><span class="compliance-manager-candidate__meta">${manager.departmentName ? `<span>${escapeHtml(manager.departmentName)}</span>` : ""}<span>${escapeHtml(programManagerAccountLabel(manager.accountStatus))}</span></span></button></li>`).join("")}
      </ul>
      <div class="places-modal__actions compliance-manager-picker__actions">
        <p>${escapeHtml(t("admin.oversight.inviteNewManagerAlternative"))}</p>
        <button class="btn-primary" id="invite-new-compliance-manager" type="button">Invite new program manager</button>
      </div>
    </div>
  </dialog>
  <dialog id="new-city-program-manager-dialog" class="places-modal" aria-labelledby="new-city-program-manager-title">
    <form id="new-city-program-manager-form" class="places-modal__card site-details-form">
      <h2 id="new-city-program-manager-title">Invite new program manager</h2>
      <p class="muted">This creates the manager's directory profile, sends them an invite to join the app, and selects them for this site.</p>
      <div class="form-grid form-grid--two">
        ${formInput("manager-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
        ${formInput("manager-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
      </div>
      ${formInput("manager-email", "CCSF email", "", { required: true, type: "email", autocomplete: "email" })}
      ${phoneInput("manager-phone", "Phone", "", { required: true, type: "tel", autocomplete: "tel", pattern: "(?:\\+?1[ .-]?)?\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}" })}
      <wa-select name="manager-department" label="Department" required placeholder="Choose department">
        ${departments.map((item) => `<wa-option value="${escapeHtml(item.departmentId || item.name)}">${escapeHtml(item.name)}</wa-option>`).join("")}
        <wa-option value="__add_department__" data-add-option>${escapeHtml(t("admin.oversight.addDepartment"))}</wa-option>
      </wa-select>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit" data-save-button>Send invitation</button>
        <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>
  <dialog id="new-oversight-option-dialog" class="places-modal" aria-labelledby="new-oversight-option-title">
    <form id="new-oversight-option-form" class="places-modal__card site-details-form">
      <h2 id="new-oversight-option-title" data-option-title>Add a new oversight option</h2>
      <input type="hidden" name="option-type" />
      <wa-input name="option-name" label="Name" required autocomplete="organization" data-option-input></wa-input>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit" data-save-button>Add</button>
        <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

function programManagerAccountLabel(status) {
  const key = {
    invited: "admin.users.statusInvited",
    active: "admin.users.statusActive",
    suspended: "admin.users.statusSuspended",
  }[status];
  return key ? t(key) : "";
}

function complianceManagerAssignmentRow(manager, canManageAssignments) {
  const managerId = String(manager.userId || manager.managerId || "");
  const profile = manager.manager || manager;
  const name = profile.name || manager.name || "Program manager";
  const email = profile.email || manager.email || "";
  const department = profile.departmentName || manager.departmentName || "";
  const accountStatus = profile.accountStatus || manager.accountStatus || "";
  const statusLabel = programManagerAccountLabel(accountStatus);
  return `<li class="compliance-manager-assignment" data-manager-id="${escapeHtml(managerId)}">
    <input type="hidden" name="compliance-manager-id" value="${escapeHtml(managerId)}" />
    <span class="compliance-manager-assignment__identity"><strong>${escapeHtml(name)}</strong>${email ? `<span>${escapeHtml(email)}</span>` : ""}${department ? `<span>${escapeHtml(department)}</span>` : ""}${accountStatus === "not-invited" ? `<span class="compliance-manager-assignment__warning">${escapeHtml(t("admin.oversight.invitationNeeded", { name }))}</span>${canManageAssignments ? `<button class="btn-text" type="button" data-invite-compliance-manager data-manager-id="${escapeHtml(managerId)}">Send invite</button>` : ""}` : statusLabel ? `<span class="muted">${escapeHtml(statusLabel)}</span>` : ""}</span>
    ${canManageAssignments ? `<button class="btn-danger" type="button" data-remove-compliance-manager aria-label="${escapeHtml(t("admin.oversight.removeNamed", { name }))}">${escapeHtml(t("admin.oversight.remove"))}</button>` : ""}
  </li>`;
}

function siteOversightView(state) {
  const oversight = state.site?.oversight || {};
  const department = oversight.managingCityDepartment || "";
  const managers = state.programManagers || [];
  const assignedManagerIds = new Set(
    state.assignedComplianceManagers.map((manager) => manager.managerId),
  );
  const canManageAssignments = state.capabilities.createEntities === true;
  const departments = uniqueNamedOptions([
    ...state.oversightOptions.departments,
    ...(department ? [{ name: department }] : []),
  ]);
  const systemsOfCare = uniqueNamedOptions([
    ...state.oversightOptions.systemsOfCare,
    { name: "BHS-PBH" },
    ...(oversight.managingSystemOfCare
      ? [{ name: oversight.managingSystemOfCare }]
      : []),
  ]);
  return `<form id="site-oversight-form" class="site-details-form" data-read-only="${!canEditSite(state)}" data-dirty-form>
    <fieldset aria-labelledby="city-program-managers-title"><div class="form-grid form-grid--one">
      <fieldset class="compliance-manager-assignments"><legend><h2 id="city-program-managers-title">${escapeHtml(t("admin.oversight.cityProgramManagers"))}</h2></legend>
        <ul class="compliance-manager-assignment-list" data-compliance-manager-list>
          ${managers
            .filter((manager) => assignedManagerIds.has(manager.userId))
            .map((manager) =>
              complianceManagerAssignmentRow(manager, canManageAssignments),
            )
            .join("")}
        </ul>
        ${assignedManagerIds.size ? "" : '<p class="empty-state" data-no-compliance-managers>No program managers assigned.</p>'}
        ${canManageAssignments ? `<button class="btn-secondary" id="add-compliance-manager" type="button" aria-describedby="compliance-manager-limit">${escapeHtml(t("admin.oversight.assignCityProgramManager"))}</button><p id="compliance-manager-limit" class="muted" data-compliance-manager-limit hidden>${escapeHtml(t("admin.oversight.managerLimit"))}</p>` : ""}
      </fieldset>
      <wa-select name="managing-city-department" label="Managing City department" placeholder="Choose department">
        ${departments.map((item) => `<wa-option value="${escapeHtml(item.name)}" ${department === item.name ? "selected" : ""}>${escapeHtml(item.name)}</wa-option>`).join("")}
        <wa-option value="__add_department__" data-add-option>Add a new City department…</wa-option>
      </wa-select>
      <wa-select name="managing-system-of-care" label="Managing system of care" placeholder="Choose system of care">
        ${systemsOfCare.map((item) => `<wa-option value="${escapeHtml(item.name)}" ${oversight.managingSystemOfCare === item.name ? "selected" : ""}>${escapeHtml(item.name)}</wa-option>`).join("")}
        <wa-option value="__add_system__" data-add-option>Add a new system of care…</wa-option>
      </wa-select>
    </div></fieldset>
    ${state.siteSaveError ? `<p class="error" role="alert">${escapeHtml(state.siteSaveError)}</p>` : ""}
    <button class="btn-primary" type="submit" data-save-button disabled>Save changes</button>
  </form>
  ${oversightCreationDialogs(state)}`;
}

function siteComplianceSummaryView(state) {
  const sortedTerms = [...state.siteTerms].sort((a, b) =>
    String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
  );
  const active = activeSiteTerms(sortedTerms);
  const missingLetterDetails = complianceLetterDetailsMissing(state);
  return `<section class="site-details-form compliance-status" aria-labelledby="compliance-title">
    <h2 id="compliance-title">${escapeHtml(t("admin.compliance.statusTitle"))}</h2>
    ${active ? `<div class="compliance-status-row"><p>${escapeHtml(t("admin.compliance.active"))}</p><button type="button" class="btn-danger" data-end-checks>${escapeHtml(t("admin.compliance.cancelRequirement"))}</button></div>` : `<p>${escapeHtml(t("admin.compliance.inactive"))}</p><button type="button" class="btn-primary" data-require-checks ${missingLetterDetails ? 'disabled aria-describedby="perimeter-checks-prerequisite-error"' : ""}>${escapeHtml(t("admin.compliance.requireChecks"))}</button>`}
    ${missingLetterDetails ? '<p id="perimeter-checks-prerequisite-error" class="error compliance-prerequisite-error" role="alert">Complete the Site manager, address, department, and City program manager contact details before requiring checks.</p>' : ""}
    ${active ? termsHistory([active]) : ""}
  </section>
  ${newChecksPeriodDialog(state)}
  <dialog id="end-checks-period-dialog" class="places-modal" aria-labelledby="end-checks-period-title" aria-describedby="end-checks-period-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 id="end-checks-period-title">${escapeHtml(t("admin.compliance.endTitle"))}</h2>
        <p id="end-checks-period-copy">${escapeHtml(t("admin.compliance.endConfirmation"))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">${escapeHtml(t("admin.compliance.endRequirement"))}</button>
        <button class="btn-secondary" value="cancel">${escapeHtml(t("admin.compliance.keepRequirement"))}</button>
      </div>
    </form>
  </dialog>`;
}

function complianceLetterDetailsMissing(state) {
  const site = state.site;
  if (!site) return true;
  const oversight = site.oversight || {};
  return !(
    site.name &&
    site.address &&
    state.assignedUsers.some((manager) =>
      Boolean(manager.firstName && manager.lastName),
    ) &&
    oversight.managingCityDepartment
  );
}

/** The same numbered descriptions appear in setup and the history reference. */
function complianceReasons() {
  return ["1", "2", "3", "4", "6"].map((number) => [
    number,
    t(`admin.compliance.reason${number}`),
  ]);
}

function complianceReasonsDialog() {
  return `<dialog id="compliance-reasons-dialog" class="places-modal compliance-reasons-dialog" aria-labelledby="compliance-reasons-title">
    <form class="places-modal__card" method="dialog">
      <div class="compliance-reasons-dialog__close-row">
        <button class="btn-icon" type="submit" value="close" aria-label="${escapeHtml(t("common.close"))}" autofocus><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
      </div>
      <div class="places-modal__copy">
        <h2 id="compliance-reasons-title">${escapeHtml(t("admin.compliance.reasonsTitle"))}</h2>
        <ol class="compliance-reasons-list">${complianceReasons()
          .map(
            ([number, text]) =>
              `<li value="${number}">${escapeHtml(text)}</li>`,
          )
          .join("")}</ol>
      </div>
    </form>
  </dialog>`;
}

function newChecksPeriodDialog(state) {
  const mappedReason = {
    permanent_supportive_housing: "2",
    shelter: "3",
    drop_in: "4",
  }[state.site?.siteType || ""];
  const reasons = complianceReasons();
  return `<dialog id="new-checks-period-dialog" class="places-modal compliance-period-dialog" aria-labelledby="new-checks-period-title">
    <form id="site-compliance-form" class="places-modal__card site-details-form" novalidate>
      <div class="places-modal__copy">
        <h3 class="places-modal__title" id="new-checks-period-title">Set up the perimeter check requirement</h3>
        <p>Indicate why perimeter checks will apply.</p>
        <fieldset class="form-grid form-grid--one compliance-period-reasons">
          <legend>Select one or more reasons</legend>
          ${reasons.map(([value, label]) => `<wa-checkbox name="terms-reason" value="${value}" ${mappedReason === value ? "checked" : ""}>${escapeHtml(label)}</wa-checkbox>`).join("")}
        </fieldset>
        <div class="form-grid form-grid--one compliance-period-fields">
          <wa-number-input name="terms-checks-per-day" label="${escapeHtml(t("siteAdmin.compliance.checksPerDay"))}" min="1" max="8" step="1" value="3" required>
            <wa-icon slot="decrement-icon" name="minus" aria-hidden="true"></wa-icon>
            <wa-icon slot="increment-icon" name="plus" aria-hidden="true"></wa-icon>
          </wa-number-input>
          <wa-select name="terms-site-manager-id" label="${escapeHtml(t("admin.compliance.addressLetterTo"))}" placeholder="Choose a Site manager" hint="${escapeHtml(t("admin.compliance.letterRecipientsHint"))}" required>
            ${state.assignedUsers.map((manager) => `<wa-option value="${escapeHtml(manager.userId)}" ${state.assignedUsers.length === 1 ? "selected" : ""}>${escapeHtml(`${manager.firstName || ""} ${manager.lastName || ""}`.trim())}</wa-option>`).join("")}
          </wa-select>
          <wa-input name="terms-expiry" type="date" label="Define when the check requirement will end" data-expiry-field hidden></wa-input>

        </div>
        <p class="error site-details-form__message compliance-period-error" role="alert" data-form-save-error hidden></p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit" data-save-button>${escapeHtml(t("admin.letters.saveSend"))}</button>
        <button class="btn-secondary" type="button" data-cancel-checks-period>Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function activeSiteTerms(terms) {
  const today = todayPacific();
  return terms.find(
    (term) =>
      term.status !== "cancelled" &&
      !term.endedAt &&
      term.effectiveStart <= today &&
      (!term.expiresOnExclusive || term.expiresOnExclusive > today) &&
      (!term.periodEnd || term.periodEnd >= today),
  );
}

function todayPacific() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** @param {string} name @param {string} label @param {unknown} value
 * @param {Parameters<typeof formInput>[3] & { extension?: string, extensionName?: string }} [options]
 */
function phoneInput(name, label, value, options = {}) {
  const extensionName =
    options.extensionName ||
    (name === "phone"
      ? "phoneExtension"
      : name.replace(/-phone$/, "-extension"));
  return phoneExtensionField(
    formInput(name, label, value, options),
    formInput(
      extensionName,
      t("admin.phone.extension"),
      options.extension || "",
      {
        autocomplete: "tel-extension",
        maxlength: 20,
        disabled: options.disabled,
      },
    ),
    escapeHtml(t("admin.phone.addExtension")),
    Boolean(options.extension),
    escapeHtml(t("admin.phone.removeExtension")),
  );
}

/**
 * @param {string} name
 * @param {string} label
 * @param {unknown} value
 * @param {{ required?: boolean, disabled?: boolean, type?: string, autocomplete?: string, pattern?: string, maxlength?: number, min?: number, max?: number, step?: number }} [options]
 */
function formInput(name, label, value, options = {}) {
  const attributes = [
    options.required ? "required" : "",
    options.disabled ? "disabled" : "",
    options.autocomplete
      ? `autocomplete="${escapeHtml(options.autocomplete)}"`
      : "",
    options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : "",
    options.maxlength !== undefined ? `maxlength="${options.maxlength}"` : "",
    options.min !== undefined ? `min="${options.min}"` : "",
    options.max !== undefined ? `max="${options.max}"` : "",
    options.step !== undefined ? `step="${options.step}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<wa-input label="${escapeHtml(label)}" name="${escapeHtml(name)}" type="${escapeHtml(options.type || "text")}" value="${escapeHtml(value ?? "")}" data-initial-value="${escapeHtml(value ?? "")}" ${attributes}></wa-input>`;
}

/** Enable a form's Save action only while its current values differ from its initial values. */
function syncDirtyForm(form, initialize = false) {
  const snapshot = JSON.stringify(
    [...form.elements]
      .filter((control) => control.name)
      .map((control) => [
        control.name,
        control.localName === "wa-checkbox"
          ? Boolean(control.checked)
          : control.value,
        control.value,
      ]),
  );
  if (initialize || !form.dataset.initialValues) {
    form.dataset.initialValues = snapshot;
  }
  form.dataset.isDirty = String(
    form.dataset.readOnly !== "true" && snapshot !== form.dataset.initialValues,
  );
  const saveButton = form.querySelector("[data-save-button]");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled =
      form.dataset.readOnly === "true" ||
      form.dataset.saving === "true" ||
      snapshot === form.dataset.initialValues;
  }
}

/** @param {HTMLFormElement} form */
function syncProviderDetailsForm(form) {
  const nameInput = form.querySelector("wa-input[name='provider-name']");
  const initialValue = nameInput?.getAttribute("data-initial-value") || "";
  const isDirty = String(nameInput?.value || "") !== initialValue;
  form.dataset.isDirty = String(isDirty);
  const saveButton = form.querySelector("[data-save-button]");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = !isDirty;
  }
}

/**
 * Keep each independently saved Site details section tied only to its own edits.
 * @param {HTMLFormElement} form
 * @param {boolean} [initialize]
 * @returns {boolean}
 */
function syncSiteDetailsForm(form, initialize = false) {
  const sections = {
    details: [
      "site-name",
      "site-type",
      "public-contact-email",
      "public-contact-phone",
      "public-contact-extension",
    ],
    address: ["street-address", "city", "state", "zip"],
    leadProgram: ["lead-program-id", "lead-provider-id"],
    siteManager: ["site-manager-user-id"],
  };
  /** @param {string[]} names @param {boolean} [useDeclaredInitialValue] */
  const snapshot = (names, useDeclaredInitialValue = false) =>
    JSON.stringify(
      names.map((name) => {
        const control = form.querySelector(`[name='${name}']`);
        const declaredInitialValue =
          control?.getAttribute("data-initial-value");
        return [
          name,
          useDeclaredInitialValue && declaredInitialValue !== null
            ? declaredInitialValue
            : controlValue(form, name),
        ];
      }),
    );
  if (initialize || !form.dataset.sectionInitialValues) {
    form.dataset.sectionInitialValues = JSON.stringify(
      Object.fromEntries(
        Object.entries(sections).map(([name, fields]) => [
          name,
          snapshot(fields, true),
        ]),
      ),
    );
    form.dataset.editedSections = "[]";
  }
  const initial = JSON.parse(form.dataset.sectionInitialValues || "{}");
  const dirty = Object.fromEntries(
    Object.entries(sections).map(([name, fields]) => [
      name,
      snapshot(fields) !== initial[name],
    ]),
  );
  const editedSections = new Set(
    JSON.parse(form.dataset.editedSections || "[]"),
  );
  const isDirty =
    form.dataset.readOnly !== "true" &&
    Object.entries(dirty).some(
      ([name, sectionIsDirty]) => sectionIsDirty && editedSections.has(name),
    );
  form.dataset.isDirty = String(isDirty);
  const controls = {
    details: form.querySelector("[data-save-site-details]"),
    address: form.querySelector("[data-save-address]"),
    leadProgram: form.querySelector("[data-save-lead-program]"),
    siteManager: form.querySelector("[data-save-site-manager]"),
  };
  for (const [name, control] of Object.entries(controls)) {
    if (control instanceof HTMLButtonElement)
      control.disabled =
        form.dataset.readOnly === "true" ||
        !dirty[name] ||
        !editedSections.has(name);
  }
  if (controls.siteManager instanceof HTMLButtonElement && dirty.leadProgram) {
    controls.siteManager.disabled = true;
  }
  return isDirty;
}

/**
 * Record the section touched by a genuine user interaction. Web components can
 * emit setup events while upgrading, which must not enable Save actions.
 * @param {HTMLFormElement} form
 * @param {Event} event
 */
function markSiteDetailsSectionEdited(form, event) {
  if (form.dataset.readOnly === "true" || !event.isTrusted) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const name = target.getAttribute("name") || "";
  const section = {
    "site-name": "details",
    "site-type": "details",
    "public-contact-email": "details",
    "public-contact-phone": "details",
    "public-contact-extension": "details",
    "address-query": "address",
    "street-address": "address",
    city: "address",
    state: "address",
    zip: "address",
    "lead-program-id": "leadProgram",
    "lead-provider-id": "leadProgram",
    "site-manager-user-id": "siteManager",
  }[name];
  if (!section) return;
  const editedSections = new Set(
    JSON.parse(form.dataset.editedSections || "[]"),
  );
  editedSections.add(section);
  form.dataset.editedSections = JSON.stringify([...editedSections]);
}

/**
 * Report validity only for the controls saved by the current section action.
 * @param {HTMLFormElement} form
 * @param {string[]} names
 */
function reportNamedControlsValidity(form, names) {
  return names.every((name) => {
    const control = form.querySelector(`[name='${name}']`);
    return (
      typeof control?.reportValidity !== "function" || control.reportValidity()
    );
  });
}

function showFormSaveError(form, message) {
  let error = form.querySelector("[data-form-save-error]");
  if (!error) {
    error = document.createElement("p");
    error.className = "error site-details-form__message";
    error.setAttribute("role", "alert");
    error.setAttribute("data-form-save-error", "");
    const saveControl = form.querySelector(
      "[data-save-button], [data-save-site-details]",
    );
    if (saveControl) saveControl.before(error);
    else form.append(error);
  }
  error.textContent = message;
  error.hidden = false;
  return error;
}

/**
 * Read a Web Awesome or native form control directly. This avoids depending on
 * form-associated custom elements having finished upgrading before submission.
 * @param {HTMLFormElement} form
 * @param {string} name
 */
function controlValue(form, name) {
  const control = /** @type {{ value?: unknown } | null} */ (
    form.querySelector(`[name='${name}']`)
  );
  if (control instanceof Element && control.localName === "wa-select") {
    const selectedOption = [...control.querySelectorAll("wa-option")].find(
      (option) =>
        option.getAttribute("aria-selected") === "true" ||
        Boolean(/** @type {any} */ (option).selected),
    );
    if (selectedOption) {
      return String(selectedOption.getAttribute("value") ?? "").trim();
    }
  }
  return String(control?.value ?? "").trim();
}

/**
 * Keep a Web Awesome select's host value and option state in sync. This is
 * especially important when restoring the previous choice after an “Add new”
 * directory action.
 * @param {Element & { value?: unknown }} select
 * @param {string} value
 */
function setSelectValue(select, value) {
  select.querySelectorAll("wa-option").forEach((option) => {
    const selected = option.getAttribute("value") === value;
    /** @type {any} */ (option).selected = selected;
    option.toggleAttribute("selected", selected);
  });
  select.value = value;
}

/** @param {HTMLFormElement} form */
function selectedComplianceReasons(form) {
  return [...form.querySelectorAll("wa-checkbox[name='terms-reason']")]
    .filter((checkbox) => /** @type {any} */ (checkbox).checked)
    .map((checkbox) => String(/** @type {any} */ (checkbox).value));
}

/** @param {HTMLFormElement} form */
function compliancePeriodValidationError(form) {
  const reasons = selectedComplianceReasons(form);
  if (!reasons.length)
    return "Select at least one reason for requiring perimeter checks.";
  if (
    reasons.some((reason) => ["1", "6"].includes(reason)) &&
    !controlValue(form, "terms-expiry")
  ) {
    return "Enter the last day checks are required for the selected reasons.";
  }
  const checksPerDay = Number(controlValue(form, "terms-checks-per-day"));
  if (!Number.isInteger(checksPerDay) || checksPerDay < 1 || checksPerDay > 8) {
    return t("admin.compliance.invalidCadence");
  }
  return "";
}

/** @param {unknown} value */
function splitPersonName(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return { firstName: parts.shift() || "", lastName: parts.join(" ") };
}

/** @param {Record<string, unknown>} values */
function hasEnteredValues(values) {
  return Object.values(values).some((value) => String(value || "").trim());
}

/** @param {FormData} data @param {string} name */
function formValue(data, name) {
  return String(data.get(name) || "").trim();
}

function todayIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * @param {{ latitude?: number, longitude?: number } | undefined} location
 * @returns {location is { latitude: number, longitude: number }}
 */
function hasSiteCoordinates(location) {
  return (
    typeof location?.latitude === "number" &&
    typeof location.longitude === "number"
  );
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function siteSaveErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "lead_program_required") {
    return "Choose a Lead program before saving.";
  }
  if (code === "site_creation_incomplete") {
    return "The Site was created, but its address, manager, or public contact was not fully saved. Reopen the Site and complete the missing fields.";
  }
  if (code === "invalid_public_contact") {
    return "Enter a valid public contact email and 10-digit phone number.";
  }
  if (code === "address_not_found") {
    return "We couldn't geocode this address. Check it and try again.";
  }
  if (code === "geocoding_unavailable") {
    return "The geocoding service is unavailable. Try again shortly.";
  }
  if (code === "address_required") {
    return "Enter an address before saving the site.";
  }
  if (code === "invalid_address") {
    return "Enter a complete address with a two-letter state and valid ZIP code.";
  }
  if (code === "invalid_contact_person") {
    return "Enter the contact's first and last name, a valid email, and a valid US phone number.";
  }
  if (code === "invalid_oversight") {
    return "Check the City program manager, department, and system of care.";
  }
  if (code === "valid_phone_required") {
    return "Enter a valid 10-digit City program manager phone number.";
  }
  if (code === "invalid_compliance") {
    return t("admin.compliance.checkInputs");
  }
  if (
    code === "invalid_compliance_letter" ||
    code === "pdf_required" ||
    code === "invalid_file_size"
  ) {
    return "Choose a PDF compliance letter no larger than 10 MB.";
  }
  if (code === "compliance_letter_upload_failed") {
    return "The compliance letter upload failed. Try again.";
  }
  if (code === "site_update_conflict") {
    return "Someone else updated this site. Reload it before saving your changes.";
  }
  return adminErrorMessage(error, t, t("admin.toast.requestFailed"));
}

function compliancePeriodErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "generator_contact_required")
    return t("admin.compliance.generatorContactRequired", {
      profile: t("admin.profile.title"),
    });
  if (code === "generator_department_required")
    return t("admin.compliance.generatorDepartmentRequired");
  if (code === "expiry_required")
    return "Enter the last day checks are required for the selected reasons.";
  if (code === "letter_details_required")
    return "Complete the Site manager, address, department, and City program manager contact details before requiring checks.";
  if (code === "terms_overlap" || code === "terms_start_conflict")
    return "This compliance period overlaps another period for the Site.";
  return "The perimeter check compliance period couldn't be saved. Try again.";
}

function managerSaveErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "first_name_required") return "Enter the manager's first name.";
  if (code === "last_name_required") return "Enter the manager's last name.";
  if (code === "valid_email_required" || code === "invalid_manager_email")
    return "Enter a valid contact email.";
  if (code === "phone_required") return "Enter a contact phone number.";
  if (code === "manager_membership_exists")
    return "This manager is already assigned to one of the selected Sites.";
  if (code === "manager_membership_conflict")
    return "A Site assignment changed. Reload the manager and try again.";
  return "The site manager couldn't be saved. Try again.";
}

/** @param {"site"|"provider"} scope @param {string} membershipId */
function enrollmentOptions(scope, membershipId) {
  const id = `enrollment-options-${scope}-${encodeURIComponent(membershipId)}`;
  const attribute =
    scope === "provider"
      ? "data-issue-provider-manager-grant"
      : "data-issue-manager-grant";
  return `<button class="btn-secondary" type="button" popovertarget="${id}" aria-haspopup="menu">${escapeHtml(t("admin.enrollment.moreOptions"))}</button>
    <div class="admin-settings-menu" id="${id}" popover role="menu" aria-label="${escapeHtml(t("admin.enrollment.moreOptions"))}">
      <button class="btn-secondary" type="button" role="menuitem" ${attribute}="${escapeHtml(membershipId)}" data-delivery-mode="code" autofocus popovertarget="${id}" popovertargetaction="hide">
        <wa-icon name="envelope" aria-hidden="true"></wa-icon><span>${escapeHtml(t("admin.enrollment.emailCode"))}</span>
      </button>
    </div>`;
}
