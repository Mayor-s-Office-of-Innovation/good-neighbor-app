import "../../frontend/src/styles/overlays.css";
import {
  beginEnrollmentRequest,
  syncEnrollmentRequests,
} from "./enrollment-request.js";
import { bindManagerAssignmentSearch } from "./manager-assignment-search.js";
import {
  clearEnrollmentCodeView,
  bindEnrollmentCodeExpiry,
} from "./enrollment-code-view.js";
import { bind311Batch } from "./site-311-batch.js";
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
import { confirmDeviceRevocation } from "./device-revocation-dialog.js";
import "../../frontend/src/components/app-toasts.js";
import {
  captureComplianceDraft,
  complianceDraftAfterNavigation,
  restoreComplianceDraft,
} from "./compliance-profile-draft.js";
import { bindSiteProgramCreation } from "./site-program.js";
import { bindPhoneExtensions } from "./phone-extension.js";
import { bindAdminInvitationLookup } from "./admin-invitation-lookup.js";
import { withSaveFeedback, upsertRecord } from "./save-feedback.js";
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
import { visibleRecords } from "./record-navigation.js";
import { siteManagerRoster } from "./site-managers.js";
import { debounce } from "./debounce.js";
import { loadProgramStaff } from "./program-staff.js";
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
import { canEditSite, canEditSiteManager } from "./site-permissions.js";
import {
  myProfileView,
  adminSettingsMenu,
  administratorView,
  newAdministratorView,
  adminInvitationError,
} from "./pages/admin-user/admin-user.templates.js";
import {
  discardChangesDialog,
  entityBreadcrumb,
} from "./pages/shared.templates.js";
import {
  siteManagerEditorView,
  siteManagerContactDetails,
} from "./pages/site/manager.templates.js";
import {
  siteSectionNav,
  siteSectionView,
} from "./pages/site/record.templates.js";
import { siteLettersView } from "./pages/site/compliance.templates.js";
import { directoryView } from "./pages/directory/directory.templates.js";
import { siteImportView } from "./pages/site/import.templates.js";
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
import {
  addressPartsFromForm,
  formatAddressParts,
  hasSiteCoordinates,
} from "./pages/site/site-address.js";
import {
  programManagerAccountLabel,
  complianceManagerAssignmentRow,
} from "./pages/site/oversight.templates.js";
import {
  syncDirtyForm,
  syncProviderDetailsForm,
  syncSiteDetailsForm,
  markSiteDetailsSectionEdited,
  reportNamedControlsValidity,
  showFormSaveError,
  controlValue,
  setSelectValue,
  selectedComplianceReasons,
  compliancePeriodValidationError,
  hasEnteredValues,
  formValue,
} from "./form-state.js";
import {
  siteSaveErrorMessage,
  compliancePeriodErrorMessage,
  managerSaveErrorMessage,
} from "./pages/site/save-error-messages.js";

/**
 * @typedef {ReturnType<typeof getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, deliberate311ProductionEnabled?: boolean, complianceManagerIds?: string[], siteName?: string, name?: string, siteType?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, primaryContact?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number | boolean>, perimeter?: string, perimeterUpdatedAt?: string, perimeterUpdatedBy?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, letterState?: string, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, leadProgramId?: string, programName?: string, primaryContactUserId?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {object} AdminState
 * @property {ReturnType<typeof import("./site-311-batch.js").create311Batch>} [site311Batch]
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
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.state.newSiteUsers = [];

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
      this.state.importNotice = null;
      this.state.importPreview = null;
      this.state.importResult = null;
      this.state.importApplyKey = "";
    }
    if (importId && this.state.importPreview?.importId !== importId) {
      this.state.importNotice = null;
      const result = await adminApi.getSiteImport(importId);
      if (location.pathname + location.search !== path) return;
      if (result.import.status === "complete") {
        this.state.importPreview = {
          importId,
          counts: result.import.counts,
          rows: result.rows,
        };
        this.state.importResult = { ...result.import, rows: result.rows };
        this.state.importApplyKey = "";
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
    const release = beginEnrollmentRequest(
      this,
      "provider",
      this.state.provider?.providerId,
    );
    if (!release) return;
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
    } finally {
      release();
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

  async updateProgramDetails(form) {
    const program = this.state.program;
    if (!program || !this.state.capabilities.createEntities) return false;
    const feedback = actionFeedback("admin.programs.saved");
    try {
      const result = await adminApi.updateProgram(program.programId, {
        name: formValue(new FormData(form), "program-name"),
        expectedUpdatedAt: program.updatedAt || "",
      });
      this.state.programs = upsertRecord(
        this.state.programs,
        result.program,
        "programId",
      );
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      if (this.state.program?.programId === program.programId) {
        this.state.program = { ...program, ...result.program };
        syncDirtyForm(form, true);
        this.render();
      }
      feedback.success();
      return true;
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
      const result = await adminApi.createProgram({
        name: String(data.get("program-name") || ""),
        providerId: String(data.get("program-provider") || ""),
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
        ...(expectedManagerId
          ? { primaryContactUserId: expectedManagerId }
          : {}),
        siteType: controlValue(form, "site-type"),
      });
      feedback.changed();
      const siteId = result.site.siteId;
      let savedSite = result.site;
      if (
        !result.site.addressParts ||
        !result.site.publicContact ||
        (result.site.primaryContactUserId || "") !== expectedManagerId
      ) {
        if (expectedManagerId)
          await adminApi.assignSiteUser(siteId, expectedManagerId, true);
        const repaired = await adminApi.updateSite(siteId, {
          name: result.site.name,
          addressParts,
          publicContact: {
            email: formValue(data, "public-contact-email"),
            phone: formValue(data, "public-contact-phone"),
            phoneExtension: formValue(data, "public-contact-extension"),
          },
          ...(expectedManagerId
            ? { primaryContactUserId: expectedManagerId }
            : {}),
          siteType: controlValue(form, "site-type"),
        });
        result.site = repaired.site;
        if (
          !repaired.site?.addressParts ||
          !repaired.site?.publicContact ||
          (repaired.site?.primaryContactUserId || "") !== expectedManagerId
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

  /** @param {HTMLFormElement} form */
  async updateSiteDeliberate311(form) {
    if (!this.state.site || this.state.capabilities.createEntities !== true)
      return false;
    const site = this.state.site;
    const select = form.querySelector(
      'wa-select[name="deliberate-311-enabled"]',
    );
    const feedback = actionFeedback("admin.toast.siteSaved");
    return withSaveFeedback(
      form,
      async () => {
        const enabled = controlValue(form, "deliberate-311-enabled") === "true";
        if (select) select.disabled = true;
        try {
          const result = await adminApi.updateSiteDeliberate311(site.siteId, {
            deliberate311ProductionEnabled: enabled,
            expectedUpdatedAt: site.updatedAt || "",
          });
          this.state.sites = upsertRecord(
            this.state.sites,
            { ...site, ...result.site },
            "siteId",
          );
          if (this.state.site?.siteId === site.siteId)
            this.state.site = { ...this.state.site, ...result.site };
          syncDirtyForm(form, true);
          feedback.success();
          return true;
        } finally {
          if (select) select.disabled = false;
        }
      },
      {
        savingLabel: t("siteAdmin.edit.saving"),
        onError: (error) => {
          feedback.failure(error);
          showFormSaveError(form, adminErrorMessage(error, t));
        },
      },
    );
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
          if (leadProgramId && !leadProgram) {
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
          this.state.sites = upsertRecord(
            this.state.sites,
            this.state.site,
            "siteId",
          );
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
      }[requested] ||
      (requested === "settings" &&
      this.state.capabilities.createEntities !== true
        ? "details"
        : requested);
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
    if (section !== "settings" || !sameSite) {
      this.state.assignedComplianceManagers = (site.items || [])
        .filter((item) =>
          String(item.sk || "").startsWith("COMPLIANCE_MANAGER#"),
        )
        .map((assignment) => ({
          ...assignment,
          ...this.state.programManagers.find(
            (manager) => manager.userId === assignment.managerId,
          ),
        }));
    }
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
    this.state.importNotice = null;
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
      if (!preview || this.state.importResult?.status === "complete") return;
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
            window.history.replaceState(
              {},
              "",
              `/sites/import?importId=${encodeURIComponent(preview.importId)}`,
            );
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
    this.state.importNotice = null;
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
      const creationGeneration = this.navigationGeneration;
      let assignedMembership;
      let emailRequested = false;
      try {
        const data = new FormData(form);
        emailRequested = Boolean(data.get("email-enrollment-link"));
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
            ) => {
              const assigned = await adminApi.assignPersonToSite(siteId, {
                personId: userId,
                name,
                email,
              });
              assignedMembership = assigned?.membership;
              return assigned;
            },
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
      if (emailRequested && assignedMembership) {
        const release = beginEnrollmentRequest(this, "site", siteId);
        try {
          if (!release) throw new Error("enrollment_request_pending");
          const sent = await adminApi.createManagerGrant(
            siteId,
            assignedMembership.membershipId,
            "link",
          );
          if (sent.grant?.deliveryStatus !== "accepted")
            throw new Error("enrollment_email_failed");
          notifyAdmin("admin.enrollment.emailed", "success");
        } catch {
          notifyAdmin("admin.enrollment.createdEmailFailed", "error");
        } finally {
          release?.();
        }
      }
      form.closest("dialog")?.close();
      if (this.navigationGeneration !== creationGeneration) return;
      try {
        await this.openSite(siteId, false);
        this.querySelector(
          "#manager-membership-form [data-manager-search]",
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
  async showEnrollmentCode(scope, membershipId) {
    const id =
      scope === "site"
        ? this.state.site?.siteId
        : this.state.provider?.providerId;
    if (!id) return;
    const release = beginEnrollmentRequest(this, scope, id);
    if (!release) return;
    const view = (this.state.enrollmentCodeView ||= { codes: new Map() });
    const generation = this.navigationGeneration;
    const current = () =>
      this.state.enrollmentCodeView === view &&
      this.navigationGeneration === generation;
    this.render();
    try {
      if (scope === "site") {
        const member = this.state.managerMemberships.find(
          (m) => m.membershipId === membershipId,
        );
        if (member?.legacyAssignment) {
          const linked = await adminApi.createManagerMembership(
            id,
            member.name,
            member.email,
            this.state.site.leadProgramId,
            member.userId,
          );
          if (!current()) return;
          membershipId = linked.membership.membershipId;
          this.state.managerMemberships = this.state.managerMemberships.map(
            (m) => (m === member ? linked.membership : m),
          );
        }
      }
      const result =
        scope === "site"
          ? await adminApi.createManagerGrant(id, membershipId, "screen")
          : await adminApi.createProviderManagerGrant(
              id,
              membershipId,
              "screen",
            );
      if (!current()) return;
      view.codes.set(result.grant.grantId, {
        scope,
        id,
        grant: result.grant,
        code: result.enrollmentCode,
      });
      const field =
        scope === "site" ? "managerGrants" : "providerManagerGrants";
      this.state[field] = upsertRecord(
        this.state[field].map((grant) =>
          scope === "site" &&
          grant.membershipId === membershipId &&
          grant.status === "pending" &&
          grant.issuedBy !== "manager-email-recovery" &&
          Date.parse(grant.expiresAt) > Date.now()
            ? { ...grant, status: "replaced" }
            : grant,
        ),
        result.grant,
        "grantId",
      );
      // Site issuance replaces older pending grants for this membership.
      for (const [grantId, entry] of view.codes) {
        if (
          entry.scope === scope &&
          entry.id === id &&
          entry.grant.membershipId === membershipId &&
          grantId !== result.grant.grantId
        )
          view.codes.delete(grantId);
      }
      this.render();
      this.querySelector(
        `[data-enrollment-code="${CSS.escape(result.grant.grantId)}"]`,
      )?.focus();
    } catch (error) {
      if (current())
        notifyAdmin(
          error.message === "provider_manager_grant_already_active"
            ? "admin.enrollment.alreadyActive"
            : "admin.enrollment.screenFailed",
          "error",
        );
    } finally {
      release();
    }
  }

  async issueManagerGrant(membershipId, deliveryMode = "link") {
    const release = beginEnrollmentRequest(
      this,
      "site",
      this.state.site?.siteId,
    );
    if (!release) return;
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
    } finally {
      release();
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
    this.deviceRevocationController?.abort();
    const controller = new AbortController();
    this.deviceRevocationController = controller;
    const generation = this.navigationGeneration || 0;
    try {
      if (!this.state.site) return;
      const device = this.state.devices.find(
        (item) => (item.bindingId || item.deviceId) === deviceId,
      );
      const label = device?.label || t("admin.devices.unnamedDevice");
      const siteId = this.state.site.siteId;
      if (
        !(await confirmDeviceRevocation(label, this.state.site.name, {
          signal: controller.signal,
        }))
      ) {
        return;
      }
      if (
        controller.signal.aborted ||
        !this.isConnected ||
        (this.navigationGeneration || 0) !== generation ||
        this.state.site?.siteId !== siteId
      )
        return;
      await adminApi.revokeDevice(siteId, deviceId);
      feedback.success();
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = t("admin.devices.revokedMessage", {
        name: label,
      });
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    } finally {
      if (this.deviceRevocationController === controller)
        this.deviceRevocationController = null;
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
    bind311Batch(this, this.state, adminApi);
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
    const invitationForm = this.querySelector("#admin-user-form");
    const ensureInvitationLookup = invitationForm
      ? bindAdminInvitationLookup(
          invitationForm,
          adminApi.lookupAdminInvitation,
          t,
        )
      : null;
    invitationForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = asForm(event.currentTarget);
      if (!form.querySelector('[name="email"]').reportValidity()) return;
      void withSaveFeedback(
        form,
        async () => {
          await ensureInvitationLookup();
          if (!form.isConnected || !form.reportValidity()) return;
          return this.inviteAdministrator(form);
        },
        {
          savingLabel: t("admin.users.sending"),
          onError: (error) =>
            showFormSaveError(form, adminInvitationError(error)),
        },
      );
    });
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
      clearEnrollmentCodeView(this.state);
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
    this.querySelector("#program-details-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = asForm(event.currentTarget);
        void this.saveWithFeedback(form, () => this.updateProgramDetails(form));
      },
    );
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
          const providerChanged =
            controlValue(siteDetailsForm, "lead-provider-id") !==
            this.state.site.providerId;
          dialog.querySelector("#lead-program-confirmation-copy").hidden =
            !providerChanged;
          if (providerChanged)
            dialog.setAttribute(
              "aria-describedby",
              "lead-program-confirmation-copy",
            );
          else dialog.removeAttribute("aria-describedby");
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
      "#program-details-form, #admin-user-form, #site-oversight-form, #site-compliance-form, #site-perimeter-form, #site-manager-record-form, #provider-manager-record-form, #site-deliberate-311-form",
    ).forEach((form) => {
      const sync = () => syncDirtyForm(form);
      syncDirtyForm(form, true);
      form.addEventListener("input", sync);
      form.addEventListener("change", sync);
      form.addEventListener("reset", () => queueMicrotask(sync));
    });
    this.querySelector("#site-deliberate-311-form")?.addEventListener(
      "save-feedback-end",
      (event) => syncDirtyForm(event.currentTarget),
    );
    this.querySelector("#site-deliberate-311-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.updateSiteDeliberate311(asForm(event.currentTarget));
      },
    );
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
          this.state.site311Batch?.drafts.clear();
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
        this.state.error =
          err.message === "invalid_file_size"
            ? t("admin.import.fileTooLarge")
            : adminErrorMessage(err, t);
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
        this.state.error = adminErrorMessage(err, t);
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
    this.managerSearchCleanup?.();
    this.managerSearchCleanup = bindManagerAssignmentSearch(
      this.querySelector("#manager-membership-form"),
    );
    this.querySelector("#create-site-manager")?.addEventListener(
      "click",
      () => {
        this.querySelector("#new-site-manager-dialog")?.showModal();
        this.querySelector('[name="new-manager-first-name"]')?.focus();
      },
    );
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
      this.querySelector("#create-site-manager")?.focus();
    });
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
    this.managerSearchCleanup?.();
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
      }[requestedSection] ||
      (requestedSection === "settings" &&
      this.state.capabilities.createEntities !== true
        ? "details"
        : requestedSection);
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
                ${siteSectionNav(site.siteId, activeSiteSection, this.state.capabilities.createEntities === true)}
                ${siteSectionView(this.state, activeSiteSection, siteSubview)}
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

customElements.define("admin-app", AdminApp);
