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

import {
  clearAdminSession,
  completeAdminLoginFromUrl,
  hasAdminSession,
  signOutAdmin,
  startAdminLogin,
} from "./services/admin-auth.js";
import { adminApi } from "./services/admin-api.js";
import { getAdminConfig } from "./config.js";
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
 * @typedef {{ siteId: string, siteName?: string, name?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number>, perimeter?: string, perimeterUpdatedAt?: string, perimeterUpdatedBy?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, leadProgramId?: string, programName?: string, status?: string, updatedAt?: string }} AdminSite
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
 * @property {any[]} siteManagers
 * @property {any | null} siteManager
 * @property {boolean} managerDirectoryLoaded
 * @property {{ departments: any[], systemsOfCare: any[] }} oversightOptions
 * @property {any | null} program
 * @property {AdminProvider | null} provider
 * @property {AdminSite | null} site
 * @property {any[]} assignedUsers
 * @property {any[]} availableSiteUsers
 * @property {any[]} newSiteUsers
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
 * @property {string} role
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
      oversightOptions: { departments: [], systemsOfCare: [] },
      program: null,
      provider: null,
      site: null,
      assignedUsers: [],
      availableSiteUsers: [],
      newSiteUsers: [],
      siteTerms: [],
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
      oversightOptions: { departments: [], systemsOfCare: [] },
      program: null,
      provider: null,
      site: null,
      assignedUsers: [],
      availableSiteUsers: [],
      newSiteUsers: [],
      siteTerms: [],
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
    window.addEventListener("popstate", this.routeChanged);
    window.addEventListener("beforeunload", this.beforeUnload);
    if (this.state.hasToken) {
      this.loadDirectory().catch((error) => {
        this.state.error = error.message;
        this.render();
      });
    }
  }

  disconnectedCallback() {
    window.removeEventListener("popstate", this.routeChanged);
    window.removeEventListener("beforeunload", this.beforeUnload);
  }

  beforeUnload = (event) => {
    if (!this.hasUnsavedSiteChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  };

  routeChanged = () => {
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
    this.openRoute().catch((error) => {
      this.state.error = error.message;
      this.render();
    });
  };

  hasUnsavedSiteChanges() {
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
    if (saved && destination) navigate(destination);
  }

  async loadDirectory() {
    const [session, providers, programs, oversightOptions] = await Promise.all([
      adminApi.getSession(),
      adminApi.listProviders(),
      adminApi.listPrograms(),
      adminApi
        .listOversightOptions()
        .catch(() => ({ departments: [], systemsOfCare: [] })),
    ]);
    this.state.role = session.role || "";
    this.state.capabilities = session.capabilities || {};
    let programManagers = { programManagers: [] };
    if (typeof adminApi.listCityProgramManagers === "function") {
      programManagers = await adminApi
        .listCityProgramManagers()
        .catch(() => ({ programManagers: [] }));
    }
    this.state.providers = providers.providers || [];
    this.state.programs = programs.programs || [];
    this.state.programManagers = programManagers.programManagers || [];
    this.state.oversightOptions = {
      departments: oversightOptions.departments || [],
      systemsOfCare: oversightOptions.systemsOfCare || [],
    };
    const memberships = (
      await Promise.all(
        this.state.providers.map(async (provider) => {
          const result = await adminApi.getProvider(provider.providerId);
          return result.sites || [];
        }),
      )
    ).flat();
    const uniqueSiteIds = [...new Set(memberships.map((site) => site.siteId))];
    this.state.sites = (
      await Promise.all(
        uniqueSiteIds.map(async (siteId) => {
          const result = await adminApi.getSite(siteId);
          const site = result.items?.find((item) => item.sk === "#META");
          return site
            ? {
                ...site,
                managerMemberships: (result.items || []).filter(
                  (item) =>
                    item.type === "managerMembership" &&
                    item.status === "active",
                ),
              }
            : null;
        }),
      )
    ).filter(Boolean);
    await this.openRoute();
  }

  async openRoute() {
    const route = currentRoute();
    if (route.name === "administrators") {
      if (!this.state.capabilities.manageAdminUsers)
        return navigate("/sites", { replace: true });
      const result = await adminApi.listAdminUsers();
      this.state.adminUsers = result.users || [];
      this.state.adminUserDirectoryMode = result.directoryMode || "cognito";
      this.state.provider = null;
      this.state.program = null;
      this.state.site = null;
      this.state.siteManager = null;
      this.render();
      return;
    }
    if (route.name === "manager-new") {
      await this.loadSiteManagers();
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
    if (route.name === "managers") await this.loadSiteManagers();
    if (route.name === "site-new") return this.openNewSiteFlow();
    if (route.name === "site-import") return this.openSiteImport();
    if (route.name === "provider") return this.openProvider(route.id, false);
    if (route.name === "program") return this.openProgram(route.id, false);
    if (route.name === "site") return this.openSite(route.id, false);
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async loadSiteManagers(force = false) {
    if (this.state.managerDirectoryLoaded && !force) return;
    const activePrograms = this.state.programs.filter(
      (program) => program.status !== "inactive",
    );
    const activeSites = this.state.sites.filter(
      (site) => site.status !== "inactive",
    );
    const [programDetails, siteMemberships] = await Promise.all([
      Promise.all(
        activePrograms.map((program) => adminApi.getProgram(program.programId)),
      ),
      Promise.all(
        activeSites.map(async (site) => ({
          site,
          memberships: (await adminApi.listManagerMemberships(site.siteId))
            .memberships,
        })),
      ),
    ]);
    const memberships = siteMemberships.flatMap(({ site, memberships }) =>
      (memberships || []).map((membership) => ({
        ...membership,
        siteId: site.siteId,
        siteName: site.name,
        leadProgramId: site.leadProgramId,
      })),
    );
    this.state.siteManagers = programDetails
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
    this.state.managerDirectoryLoaded = true;
  }

  async openSiteManager(userId) {
    await this.loadSiteManagers();
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.siteManager =
      this.state.siteManagers.find((manager) => manager.userId === userId) ||
      null;
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    if (!this.state.siteManager) this.state.error = "Site manager not found.";
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openNewSiteFlow() {
    const programId = new URLSearchParams(window.location.search).get(
      "programId",
    );
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.newSiteUsers = [];
    if (programId) {
      const result = await adminApi.getProgram(programId);
      this.state.newSiteUsers = (result.users || []).filter(
        (user) => user.status !== "inactive",
      );
    }
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openSiteImport() {
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
      if (result.import.status === "complete") {
        this.state.importPreview = null;
        this.state.importResult = null;
        this.state.importApplyKey = "";
        window.history.replaceState({}, "", "/sites/import");
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
    this.state.importHistory = history.imports || [];
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
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
    const name = new FormData(form).get("provider-name");
    if (!name) return;
    const result = await adminApi.createProvider(String(name));
    form.reset();
    await this.loadDirectory();
    const params = new URLSearchParams(window.location.search);
    if (params.get("returnTo") === "site-new") {
      navigate(
        `/sites/new?providerId=${encodeURIComponent(result.provider.providerId)}`,
      );
      return;
    }
    navigate(`/providers/${encodeURIComponent(result.provider.providerId)}`);
  }

  async updateProvider(form) {
    if (!this.state.provider) return;
    const name = formValue(new FormData(form), "provider-name");
    const result = await adminApi.updateProvider(
      this.state.provider.providerId,
      { name },
    );
    this.state.provider = {
      ...this.state.provider,
      ...result.provider,
    };
    this.state.providers = this.state.providers.map((provider) =>
      provider.providerId === result.provider.providerId
        ? { ...provider, ...result.provider }
        : provider,
    );
    this.state.siteSaveMessage = "Provider saved successfully.";
    this.render();
  }

  async addProgramToProvider(form) {
    if (!this.state.provider) return;
    const providerId = this.state.provider.providerId;
    const programId = formValue(new FormData(form), "program-id");
    if (!programId) return;
    await adminApi.assignProgramToProvider(providerId, programId);
    await this.loadDirectory();
  }

  /**
   * Open one provider and list its sites.
   * @param {string} providerId
   * @returns {Promise<void>}
   */
  async openProvider(providerId, updateUrl = true) {
    if (updateUrl)
      return navigate(`/providers/${encodeURIComponent(providerId)}`);
    const data = await adminApi.getProvider(providerId);
    this.state.provider = data.provider;
    this.state.program = null;
    this.state.site = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.provider.sites = data.sites || [];
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openProgram(programId, updateUrl = true) {
    if (updateUrl)
      return navigate(`/programs/${encodeURIComponent(programId)}`);
    const data = await adminApi.getProgram(programId);
    this.state.program = {
      ...data.program,
      sites: data.sites,
      users: data.users,
    };
    this.state.provider = null;
    this.state.site = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async createProgram(form) {
    const data = new FormData(form);
    const result = await adminApi.createProgram({
      name: String(data.get("program-name") || ""),
      providerId: String(data.get("program-provider") || ""),
      contact: {
        firstName: String(data.get("contact-first-name") || ""),
        lastName: String(data.get("contact-last-name") || ""),
        phone: String(data.get("contact-phone") || ""),
        email: String(data.get("contact-email") || ""),
      },
    });
    await this.loadDirectory();
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
  }

  /** @param {HTMLFormElement} form */
  async updateProgramContact(form) {
    if (!this.state.program) return;
    const data = new FormData(form);
    const result = await adminApi.updateProgram(this.state.program.programId, {
      name: this.state.program.name,
      contact: {
        firstName: formValue(data, "program-contact-first-name"),
        lastName: formValue(data, "program-contact-last-name"),
        phone: formValue(data, "program-contact-phone"),
        email: formValue(data, "program-contact-email"),
      },
    });
    this.state.program = {
      ...this.state.program,
      ...result.program,
    };
    this.state.programs = this.state.programs.map((program) =>
      program.programId === result.program.programId
        ? { ...program, ...result.program }
        : program,
    );
    this.state.siteSaveMessage = "Primary contact saved.";
    this.render();
  }

  async createCityProgramManager(form) {
    const data = new FormData(form);
    const result = await adminApi.createCityProgramManager({
      firstName: formValue(data, "manager-first-name"),
      lastName: formValue(data, "manager-last-name"),
      email: formValue(data, "manager-email"),
    });
    this.state.programManagers = [
      ...this.state.programManagers,
      result.programManager,
    ].sort((a, b) => a.name.localeCompare(b.name));
    this.finishOversightOptionFlow(
      "program-manager-id",
      result.programManager.userId,
      form,
    );
  }

  async createOversightOption(form) {
    const data = new FormData(form);
    const type = formValue(data, "option-type");
    const result = await adminApi.createOversightOption({
      type,
      name: formValue(data, "option-name"),
    });
    const key = type === "department" ? "departments" : "systemsOfCare";
    this.state.oversightOptions[key] = [
      ...this.state.oversightOptions[key],
      result.option,
    ].sort((a, b) => a.name.localeCompare(b.name));
    this.finishOversightOptionFlow(
      type === "department"
        ? "managing-city-department"
        : "managing-system-of-care",
      result.option.name,
      form,
    );
  }

  finishOversightOptionFlow(selectName, value, form) {
    const select = this.querySelector(`wa-select[name='${selectName}']`);
    if (select) {
      const option = document.createElement("wa-option");
      option.value = value;
      option.textContent =
        selectName === "program-manager-id"
          ? this.state.programManagers.find((item) => item.userId === value)
              ?.name || value
          : value;
      select.querySelector(`[value='${CSS.escape(value)}']`)?.remove();
      select.querySelector("[data-add-option]")?.before(option);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    form.closest("dialog")?.close();
    form.reset();
  }

  async createSiteFromFlow(form) {
    const data = new FormData(form);
    const providerId = formValue(data, "provider-id");
    const programId = formValue(data, "lead-program-id");
    const addressParts = addressPartsFromForm(data);
    const address = formatAddressParts(addressParts);
    const result = await adminApi.createSite(providerId, {
      name: formValue(data, "site-name"),
      address,
      addressParts,
      leadProgramId: programId,
      publicContact: {
        email: formValue(data, "public-contact-email"),
        phone: formValue(data, "public-contact-phone"),
      },
      primaryContactUserId: formValue(data, "site-manager-user-id"),
    });
    const siteId = result.site.siteId;
    const expectedManagerId = formValue(data, "site-manager-user-id");
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
        },
        primaryContactUserId: expectedManagerId,
      });
      if (
        !repaired.site?.addressParts ||
        !repaired.site?.publicContact ||
        repaired.site?.primaryContactUserId !== expectedManagerId
      ) {
        throw new Error("site_creation_incomplete");
      }
    }
    await this.loadDirectory();
    navigate(`/sites/${encodeURIComponent(siteId)}`);
  }

  /**
   * Deactivate a provider and return to the provider list.
   * @param {string} providerId
   * @returns {Promise<void>}
   */
  async deactivateProvider(providerId) {
    await adminApi.deactivateProvider(providerId);
    this.state.provider = null;
    this.state.site = null;
    await this.loadProviders();
  }

  /**
   * @param {HTMLFormElement} form
   * @param {"all" | "details" | "address" | "lead-program" | "site-manager"} [section]
   */
  async updateSite(form, section = "all") {
    if (!this.state.site) return;
    const data = new FormData(form);
    const name = formValue(data, "site-name");
    const leadProgramId = formValue(data, "lead-program-id");
    const internalContactUserId = formValue(data, "site-manager-user-id");
    const addressParts = data.has("street-address")
      ? addressPartsFromForm(data)
      : null;
    const publicContact = {
      email: formValue(data, "public-contact-email"),
      phone: formValue(data, "public-contact-phone"),
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
    if (section === "all" || section === "site-manager")
      values.primaryContactUserId = internalContactUserId;
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
        leadProgramId !== String(this.state.site.leadProgramId || "")
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
          leadProgram.providerId,
          leadProgramId,
        );
        this.state.site = { ...this.state.site, ...reassignment.site };
      }
      if (
        (section === "all" || section === "site-manager") &&
        internalContactUserId &&
        internalContactUserId !== this.state.site.primaryContactUserId
      ) {
        const siteId = this.state.site.siteId;
        await adminApi.assignSiteUser(siteId, internalContactUserId, true);
        if (section === "site-manager") {
          await this.openSite(siteId, false);
          this.state.siteSaveMessage = "Site manager saved successfully.";
          return true;
        }
      }
      if (section === "lead-program") {
        this.state.siteSaveMessage = "Lead program saved successfully.";
        return true;
      }
      const result = await adminApi.updateSite(this.state.site.siteId, values);
      this.state.site = { ...this.state.site, ...result.site };
      this.state.sites = this.state.sites.map((site) =>
        site.siteId === this.state.site?.siteId
          ? { ...site, ...this.state.site }
          : site,
      );
      if (values.addressParts && !hasSiteCoordinates(result.site?.location)) {
        this.state.siteSaveError =
          "The address was saved, but geocoding did not return coordinates. Try saving it again.";
        return false;
      }
      this.state.siteSaveMessage =
        section === "site-manager"
          ? "Site manager saved successfully."
          : section === "address"
            ? "Address saved successfully."
            : "Site details saved successfully.";
      return true;
    } catch (error) {
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
  }

  async updateOversight(form) {
    if (!this.state.site) return false;
    const data = new FormData(form);
    const oversight = {
      managingCityDepartment: formValue(data, "managing-city-department"),
      managingSystemOfCare: formValue(data, "managing-system-of-care"),
      cityProgramManagerId:
        this.state.programManagers.find(
          (manager) => manager.userId === formValue(data, "program-manager-id"),
        )?.userId ||
        (formValue(data, "program-manager-id") === "legacy-existing"
          ? this.state.site.oversight?.cityProgramManagerId || ""
          : ""),
      cityProgramManager:
        this.state.programManagers.find(
          (manager) => manager.userId === formValue(data, "program-manager-id"),
        )?.name ||
        (formValue(data, "program-manager-id") === "legacy-existing"
          ? this.state.site.oversight?.cityProgramManager || ""
          : ""),
    };
    this.state.siteSaving = true;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.error = "";
    try {
      const result = await adminApi.updateSite(this.state.site.siteId, {
        name: this.state.site.name,
        oversight,
      });
      this.state.site = { ...this.state.site, ...result.site };
      this.state.sites = this.state.sites.map((site) =>
        site.siteId === this.state.site?.siteId
          ? { ...site, ...this.state.site }
          : site,
      );
      this.state.siteSaveMessage = "Oversight saved successfully.";
      return true;
    } catch (error) {
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
  }

  async updatePerimeter(form) {
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
      this.state.perimeterMessage = "Perimeter saved.";
      return true;
    } catch (error) {
      this.state.perimeterError =
        error instanceof Error && error.message === "perimeter_update_conflict"
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
  }

  /**
   * Open a site with its contacts and devices.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async openSite(siteId, updateUrl = true) {
    if (updateUrl) return navigate(`/sites/${encodeURIComponent(siteId)}`);
    const [site, memberships, grants, devices, terms] = await Promise.all([
      adminApi.getSite(siteId),
      adminApi.listManagerMemberships(siteId),
      adminApi.listManagerGrants(siteId),
      adminApi.listDevices(siteId),
      adminApi.listSiteTerms(siteId),
    ]);
    this.state.site = site.items?.find((item) => item.sk === "#META") || null;
    this.state.assignedUsers = (site.items || []).filter((item) =>
      String(item.sk || "").startsWith("ASSIGNED_USER#"),
    );
    this.state.availableSiteUsers = [];
    if (this.state.site?.leadProgramId) {
      const program = await adminApi.getProgram(this.state.site.leadProgramId);
      this.state.availableSiteUsers = (program.users || []).filter(
        (user) => user.status !== "inactive",
      );
      const currentUsers = new Map(
        this.state.availableSiteUsers.map((user) => [user.userId, user]),
      );
      this.state.assignedUsers = this.state.assignedUsers.map((assignment) => ({
        ...assignment,
        ...(currentUsers.get(assignment.userId) || {}),
      }));
    }
    this.state.siteTerms = terms.terms || [];
    this.state.provider = null;
    this.state.program = null;
    this.state.managerMemberships = memberships.memberships || [];
    this.state.managerGrants = grants.grants || [];
    this.state.devices = devices.devices || [];
    this.state.issuedCode = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.perimeterSaving = false;
    this.state.perimeterMessage = "";
    this.state.perimeterError = "";
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async createSiteTerms(form) {
    if (!this.state.site) return false;
    const data = new FormData(form);
    const siteId = this.state.site.siteId;
    await adminApi.createSiteTerms(this.state.site.siteId, {
      tier: Number(data.get("terms-tier")),
      requiredChecksPerDay: Number(data.get("terms-checks-per-day")),
      effectiveStart: formValue(data, "terms-start"),
      expiresOnExclusive: formValue(data, "terms-expiry"),
    });
    window.history.replaceState(
      {},
      "",
      `/sites/${encodeURIComponent(siteId)}?section=compliance`,
    );
    await this.openSite(siteId, false);
    this.state.siteSaveMessage =
      "Compliance term saved. A new letter is being generated.";
    this.render();
    return true;
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
        this.state.importResult = result;
        if (result.rows) this.state.importPreview.rows = result.rows;
        this.render();
      } while (result.status === "applying");
      if (result.status === "complete") {
        const failed =
          Number(result.outcomes?.failed || 0) +
          Number(result.outcomes?.skipped_conflict || 0);
        const applied = Number(result.outcomes?.applied || 0);
        if (result.resultStatus === "failed" || (failed > 0 && applied === 0)) {
          this.state.importNotice = {
            title: "Import failed",
            message: `No records were imported. ${failed} ${failed === 1 ? "record needs" : "records need"} attention. See Past imports for details.`,
          };
        } else if (result.resultStatus === "partial" || failed > 0) {
          this.state.importNotice = {
            title: "Import partially completed",
            message: `${applied} ${applied === 1 ? "record was" : "records were"} imported and ${failed} ${failed === 1 ? "record was" : "records were"} not imported. See Past imports for details.`,
          };
        } else {
          this.state.importNotice = null;
        }
        sessionStorage.removeItem(`site-import-key:${preview.importId}`);
        this.state.importPreview = null;
        this.state.importResult = null;
        this.state.importApplyKey = "";
        const history = await adminApi
          .listSiteImports()
          .catch(() => ({ imports: [] }));
        this.state.importHistory = history.imports || [];
        window.history.replaceState({}, "", "/sites/import");
      }
    } finally {
      this.state.importBusy = false;
      this.render();
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
    const importId = this.state.importPreview?.importId;
    if (!importId) return;
    const blob = await adminApi.downloadSiteImportConflicts(importId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `site-import-${importId}-conflicts.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Deactivate a site and refresh the current provider.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async deactivateSite(siteId) {
    await adminApi.deactivateSite(siteId);
    this.state.sites = this.state.sites.filter(
      (site) => site.siteId !== siteId,
    );
    this.state.managerDirectoryLoaded = false;
    this.state.site = null;
    this.querySelector("[data-dirty-form]")?.setAttribute(
      "data-is-dirty",
      "false",
    );
    this.lastRenderedPath = "";
    navigate("/sites");
  }

  /** @param {HTMLFormElement} form */
  async addManagerMembership(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    const user = this.state.availableSiteUsers.find(
      (item) => item.userId === formValue(data, "manager-user-id"),
    );
    if (!user?.email)
      throw new Error(
        "Choose a Lead Program staff member with an email address.",
      );
    const currentMemberships = [...this.state.managerMemberships];
    await adminApi.createManagerMembership(
      this.state.site.siteId,
      `${user.firstName} ${user.lastName}`.trim(),
      user.email,
      this.state.site.leadProgramId,
      user.userId,
    );
    await Promise.all(
      currentMemberships.map((membership) =>
        adminApi.deactivateManagerMembership(
          this.state.site.siteId,
          membership.membershipId,
        ),
      ),
    );
    this.state.managerDirectoryLoaded = false;
    form.reset();
    await this.openSite(this.state.site.siteId, false);
  }

  /** @param {HTMLFormElement} form */
  async saveSiteManager(form) {
    const data = new FormData(form);
    const current = this.state.siteManager;
    const canManageAssignments =
      this.state.capabilities.createEntities === true;
    const programId = canManageAssignments
      ? formValue(data, "manager-program-id")
      : current?.programId || "";
    const programChanged = Boolean(current && current.programId !== programId);
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
          ? await adminApi.updateProgramUser(programId, current.userId, values)
          : await adminApi.createProgramUser(programId, values);
      }
      const user = response.user;
      const existing = new Map(
        (current?.assignedSites || []).map((site) => [site.siteId, site]),
      );
      const selected = new Set(siteIds);
      await Promise.all([
        ...siteIds
          .filter((siteId) => existing.has(siteId))
          .map((siteId) => {
            const membership = existing.get(siteId);
            return adminApi.updateManagerMembership(
              siteId,
              membership.membershipId,
              fullName,
              values.email,
            );
          }),
        ...siteIds
          .filter((siteId) => !existing.has(siteId))
          .map((siteId) =>
            adminApi.createManagerMembership(
              siteId,
              fullName,
              values.email,
              programId,
              user.userId,
            ),
          ),
        ...[...existing.entries()]
          .filter(([siteId]) => !selected.has(siteId))
          .map(([siteId, membership]) =>
            adminApi.deactivateManagerMembership(
              siteId,
              membership.membershipId,
            ),
          ),
      ]);
      if (programChanged) {
        await adminApi.updateProgramUser(current.programId, current.userId, {
          ...values,
          siteManager: false,
        });
      }
      this.state.managerDirectoryLoaded = false;
      await this.loadSiteManagers(true);
      this.state.siteManager =
        this.state.siteManagers.find(
          (manager) => manager.userId === user.userId,
        ) || null;
      this.state.siteSaveMessage = programChanged
        ? "Site manager moved to the selected Program."
        : current
          ? "Site manager saved."
          : "Site manager added.";
      this.state.siteSaveError = "";
      if (!current || user.userId !== current.userId) {
        window.history.replaceState(
          {},
          "",
          `/managers/${encodeURIComponent(user.userId)}`,
        );
      }
      this.render();
    } catch (error) {
      showFormSaveError(form, managerSaveErrorMessage(error));
    }
  }

  async removeSiteManager() {
    const manager = this.state.siteManager;
    if (!manager) return;
    try {
      await adminApi.removeSiteManager(manager.programId, manager.userId);
      this.state.managerDirectoryLoaded = false;
      this.state.siteManager = null;
      const form = this.querySelector("#site-manager-record-form");
      if (form) form.dataset.isDirty = "false";
      await this.loadSiteManagers(true);
      navigate("/managers");
    } catch (error) {
      this.state.error =
        error instanceof Error && error.message === "manager_removal_conflict"
          ? "The manager or one of their Site assignments changed. Reload and try again."
          : "The manager could not be removed. Try again.";
      this.render();
    }
  }

  /** @param {string} membershipId */
  async deactivateManagerMembership(membershipId) {
    if (!this.state.site) return;
    const membership = this.state.managerMemberships.find(
      (item) => item.membershipId === membershipId,
    );
    const result = await adminApi.deactivateManagerMembership(
      this.state.site.siteId,
      membershipId,
    );
    const siteId = this.state.site.siteId;
    await this.openSite(siteId, false);
    this.state.revocationMessage = `${membership?.name || "Site Manager"} removed; ${result.revokedBindingCount} Manager binding${result.revokedBindingCount === 1 ? "" : "s"} revoked at this Site.`;
    this.render();
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
  async issueManagerGrant(membershipId) {
    if (!this.state.site) return;
    const created = await adminApi.createManagerGrant(
      this.state.site.siteId,
      membershipId,
    );
    await this.openSite(this.state.site.siteId, false);
    this.state.managerGrants = attachCreatedEnrollmentUrl(
      this.state.managerGrants,
      created,
    );
    this.render();
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
      button.setAttribute("aria-label", "Copy enrollment link failed");
      if (status)
        status.textContent = "The enrollment link could not be copied.";
    } finally {
      button.disabled = false;
    }
  }

  /** @param {string} grantId */
  async cancelManagerGrant(grantId) {
    if (!this.state.site) return;
    await adminApi.cancelManagerGrant(this.state.site.siteId, grantId);
    await this.openSite(this.state.site.siteId, false);
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
    await this.openSite(siteId, false);
    this.state.revocationMessage = `Access for ${label} was removed from this Site.`;
    this.render();
  }

  async revokeAllSiteDevices(form) {
    if (!this.state.site) return;
    const confirmation = formValue(new FormData(form), "confirmation");
    const result = await adminApi.revokeAllSiteDeviceBindings(
      this.state.site.siteId,
      confirmation,
    );
    const siteId = this.state.site.siteId;
    await this.openSite(siteId, false);
    this.state.revocationMessage =
      result.status === "complete"
        ? `Operation ${result.operationId}: all Site credentials invalidated and ${result.affectedCount} device record${result.affectedCount === 1 ? "" : "s"} reconciled.`
        : `Operation ${result.operationId}: canonical Site credentials were invalidated, but ${result.failedCount} device record${result.failedCount === 1 ? "" : "s"} could not be reconciled. Follow the revocation runbook.`;
    this.render();
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
    if (!this.state.site || !this.state.physicalDeviceRevocationPreview) return;
    const preview = this.state.physicalDeviceRevocationPreview;
    const confirmation = formValue(new FormData(form), "confirmation");
    const result = await adminApi.revokePhysicalDeviceEverywhere(
      preview.physicalDeviceId,
      confirmation,
    );
    const siteId = this.state.site.siteId;
    await this.openSite(siteId, false);
    this.state.revocationMessage = result.alreadyRevoked
      ? "This physical device was already revoked."
      : `Operation ${result.operationId}: physical device revoked across ${result.affectedCount} Site binding${result.affectedCount === 1 ? "" : "s"}.`;
    this.render();
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
    const preview = this.state.emergencyRevocationPreview;
    if (!preview) return;
    const confirmation = formValue(new FormData(form), "confirmation");
    const result = await adminApi.startEmergencySiteRevocation(
      preview.sites.map((site) => site.siteId),
      confirmation,
    );
    this.state.emergencyRevocationSites = [];
    this.state.emergencyRevocationPreview = null;
    this.state.revocationMessage = `Operation ${result.operationId}: credentials invalidated across ${result.affectedSiteCount} Sites; ${result.queuedSiteCount} Site reconciliation job${result.queuedSiteCount === 1 ? "" : "s"} queued${result.enqueueFailedCount ? ` and ${result.enqueueFailedCount} require runbook follow-up` : ""}.`;
    this.render();
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
    const siteId = this.state.site.siteId;
    await this.openSite(siteId, false);
    this.state.revocationMessage = result.alreadySuspended
      ? "This binding was already suspended."
      : `${result.binding.label || "Device binding"} suspended. Existing credentials are invalid; re-enrollment requires a new single-Site grant.`;
    this.render();
  }

  /**
   * Bind event handlers to the currently rendered DOM.
   * @returns {void}
   */
  bind() {
    this.querySelector("#admin-user-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const form = asForm(event.currentTarget);
        if (!form.reportValidity()) return;
        const data = new FormData(form);
        adminApi
          .inviteAdminUser({
            firstName: String(data.get("firstName") || ""),
            lastName: String(data.get("lastName") || ""),
            email: String(data.get("email") || ""),
            role: String(data.get("role") || ""),
          })
          .then(() => {
            this.state.adminUserMessage = "Invitation sent.";
            return this.openRoute();
          })
          .catch((error) => {
            this.state.error = error.message;
            this.render();
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
        const request = requests[action]?.();
        if (!request) return;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = "Working…";
        request
          .then(() => {
            this.state.adminUserMessage = {
              suspend: "Administrator suspended.",
              reinstate: "Administrator reinstated.",
              reinvite: "Invitation sent again.",
              reset: "Password reset instructions sent.",
            }[action];
            return this.openRoute();
          })
          .catch((error) => {
            this.state.error = error.message;
            this.render();
          });
      });
    });
    this.querySelectorAll("[data-admin-role]").forEach((select) => {
      select.addEventListener("change", () => {
        adminApi
          .updateAdminUserRole(
            dataAttr(select, "data-username"),
            String(select.value),
          )
          .then(() => this.openRoute())
          .catch((error) => {
            this.state.error = error.message;
            this.render();
          });
      });
    });
    this.bindAddressLookup();
    this.querySelector("#directory-search")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const route = currentRoute();
        const kind =
          route.name === "managers"
            ? "managers"
            : route.name === "providers" || route.name === "programs"
              ? "providers"
              : "sites";
        const query = new FormData(asForm(event.currentTarget)).get("q");
        navigate(
          `/${kind}${String(query || "").trim() ? `?q=${encodeURIComponent(String(query).trim())}` : ""}`,
        );
      },
    );
    this.querySelector("#clear-directory-search")?.addEventListener(
      "click",
      () => {
        const route = currentRoute();
        const kind =
          route.name === "managers"
            ? "managers"
            : route.name === "providers" || route.name === "programs"
              ? "providers"
              : "sites";
        navigate(`/${kind}`);
      },
    );
    this.querySelector("#site-directory-filters")?.addEventListener(
      "change",
      (event) => {
        const route = currentRoute();
        const params = new URLSearchParams(window.location.search);
        const data = new FormData(asForm(event.currentTarget));
        for (const key of ["manager", "department", "system"]) {
          const value = String(data.get(key) || "");
          if (value) params.set(key, value);
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
      clearAdminSession();
      this.state.hasToken = false;
      this.state.providers = [];
      this.state.sites = [];
      this.state.provider = null;
      this.state.site = null;
      signOutAdmin();
    });
    this.querySelector("#provider-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createProvider(asForm(e.currentTarget)).catch((error) => {
        this.state.error = error.message;
        this.render();
      });
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
    this.querySelector("#program-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createProgram(asForm(e.currentTarget)).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector("#edit-program-contact")?.addEventListener("click", () =>
      this.querySelector("#program-contact-dialog")?.showModal(),
    );
    this.querySelector("#cancel-program-contact")?.addEventListener(
      "click",
      () => this.querySelector("#program-contact-dialog")?.close(),
    );
    this.querySelector("#program-contact-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.updateProgramContact(asForm(event.currentTarget)).catch(
          (error) => {
            showFormSaveError(
              asForm(event.currentTarget),
              error instanceof Error
                ? error.message
                : "The primary contact could not be saved.",
            );
          },
        );
      },
    );
    this.querySelectorAll("a[data-route]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        const destination = link.getAttribute("href") || "/sites";
        if (this.hasUnsavedSiteChanges())
          this.confirmSiteNavigation(destination);
        else navigate(destination);
      });
    });
    this.querySelectorAll("button[data-navigate]").forEach((button) => {
      button.addEventListener("click", () => {
        const destination = button.getAttribute("data-navigate") || "/sites";
        if (this.hasUnsavedSiteChanges())
          this.confirmSiteNavigation(destination);
        else navigate(destination);
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
        this.createSiteFromFlow(asForm(event.currentTarget)).catch((error) => {
          this.state.error = siteSaveErrorMessage(error);
          this.render();
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
      const programId = String(event.currentTarget.value || "");
      this.querySelectorAll("[data-manager-site-program]").forEach((row) => {
        const matches =
          row.getAttribute("data-manager-site-program") === programId;
        row.toggleAttribute("hidden", !matches);
        const checkbox = row.querySelector("wa-checkbox");
        if (checkbox) {
          checkbox.disabled = !matches;
        }
      });
      const hasSites = [
        ...this.querySelectorAll("[data-manager-site-program]"),
      ].some((row) => !row.hasAttribute("hidden"));
      const empty = this.querySelector("[data-manager-sites-empty]");
      if (empty) {
        empty.toggleAttribute("hidden", hasSites);
        empty.textContent = programId
          ? "This Program has no Sites to assign."
          : "Choose a Program to see available Sites.";
      }
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
      () =>
        this.querySelector("#lead-program-confirmation-dialog")?.showModal(),
    );
    this.querySelector("[data-save-site-manager]")?.addEventListener(
      "click",
      () =>
        this.querySelector("#site-manager-confirmation-dialog")?.showModal(),
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
    const siteManagerDialog = this.querySelector(
      "#site-manager-confirmation-dialog",
    );
    siteManagerDialog?.addEventListener("close", () => {
      if (
        siteManagerDialog.returnValue !== "confirm" ||
        !(siteDetailsForm instanceof HTMLFormElement) ||
        !reportNamedControlsValidity(siteDetailsForm, ["site-manager-user-id"])
      )
        return;
      this.updateSite(siteDetailsForm, "site-manager").catch((error) => {
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
    this.querySelectorAll("#site-oversight-form wa-select").forEach(
      (select) => {
        select.addEventListener("change", () => {
          const value = String(select.value || "");
          if (!value.startsWith("__add_")) return;
          const dialogId = {
            __add_manager__: "#new-city-program-manager-dialog",
            __add_department__: "#new-oversight-option-dialog",
            __add_system__: "#new-oversight-option-dialog",
          }[value];
          const dialog = this.querySelector(dialogId);
          if (!dialog) return;
          if (value !== "__add_manager__") {
            const form = dialog.querySelector("form");
            const type =
              value === "__add_department__" ? "department" : "systemOfCare";
            const label =
              type === "department" ? "City department" : "System of care";
            form.querySelector("[name='option-type']").value = type;
            form.querySelector("[data-option-title]").textContent =
              `Add a new ${label.toLowerCase()}`;
            form
              .querySelector("[data-option-input]")
              ?.setAttribute("label", `${label} name`);
          }
          select.value = select.dataset.previousValue || "";
          dialog.showModal();
          dialog.querySelector("wa-input")?.focus();
        });
        select.addEventListener("wa-show", () => {
          select.dataset.previousValue = String(select.value || "");
        });
        select.addEventListener("focus", () => {
          select.dataset.previousValue = String(select.value || "");
        });
      },
    );
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
    this.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
    this.querySelectorAll(
      "#site-oversight-form, #site-compliance-form, #site-perimeter-form, #site-manager-record-form",
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
      siteDetailsForm.addEventListener("input", sync);
      siteDetailsForm.addEventListener("change", sync);
      siteDetailsForm.addEventListener("reset", () => queueMicrotask(sync));
    }
    this.querySelector("wa-select[name='lead-program-id']")?.addEventListener(
      "change",
      async (event) => {
        const programId = String(event.currentTarget.value || "");
        const contact = this.querySelector(
          "wa-select[name='site-manager-user-id']",
        );
        const contactLabel = this.querySelector("[data-site-manager-label]");
        const contactDetails = this.querySelector(
          "#site-manager-contact-details",
        );
        if (!contact) return;
        contact.innerHTML = "";
        contact.value = "";
        contact.disabled = true;
        if (contactDetails) contactDetails.innerHTML = "";
        if (!programId) {
          if (contactLabel)
            contactLabel.textContent = "Assign a lead program first";
          return;
        }
        try {
          const program = await adminApi.getProgram(programId);
          const users = (program.users || []).filter(
            (user) => user.status !== "inactive",
          );
          this.state.availableSiteUsers = users;
          contact.innerHTML = users
            .map(
              (user) =>
                `<wa-option value="${escapeHtml(user.userId)}">${escapeHtml(`${user.firstName} ${user.lastName}`)}</wa-option>`,
            )
            .join("");
          contact.disabled = !users.length;
          if (contactLabel) {
            contactLabel.textContent = users.length
              ? "Lead Program staff member"
              : "Add staff to the program first";
          }
        } catch (error) {
          this.state.siteSaveError = error.message;
          this.render();
        }
        if (siteDetailsForm instanceof HTMLFormElement)
          syncSiteDetailsForm(siteDetailsForm);
      },
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
    this.querySelectorAll("#site-terms-form, #site-compliance-form").forEach(
      (form) =>
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          this.createSiteTerms(asForm(e.currentTarget)).catch((err) => {
            this.state.error = err.message;
            this.render();
          });
        }),
    );
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
        this.state.importNotice = {
          title: "Import failed",
          message: "The import could not be completed. Please try again.",
        };
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
    const managerMembershipSubmit = managerMembershipForm?.querySelector(
      "button[type='submit']",
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
      managerMembershipSubmit?.toggleAttribute(
        "hidden",
        !selectedUserId || isCurrentManager,
      );
    };
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
    this.querySelectorAll("[data-deactivate-site]").forEach((button) => {
      button.addEventListener("click", () => {
        this.querySelector("#deactivate-site-dialog")?.showModal();
      });
    });
    const deactivateSiteDialog = this.querySelector("#deactivate-site-dialog");
    deactivateSiteDialog?.addEventListener("close", () => {
      if (deactivateSiteDialog.returnValue !== "confirm") return;
      const button = this.querySelector("[data-deactivate-site]");
      if (!button) return;
      this.deactivateSite(dataAttr(button, "data-deactivate-site")).catch(
        (error) => {
          this.state.error =
            error instanceof Error
              ? error.message
              : "The site could not be deactivated.";
          this.render();
        },
      );
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
        ).catch((err) => {
          this.state.error = err.message;
          this.render();
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
    this.querySelectorAll("[data-device-selection]").forEach((input) => {
      input.addEventListener("change", () => this.syncDeviceSelection(input));
    });
    this.querySelector("#remove-device-this-site")?.addEventListener(
      "click",
      () => {
        const device = this.selectedDevice();
        if (!device) return;
        this.revokeDevice(device.bindingId || device.deviceId).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelector("#remove-device-all-sites")?.addEventListener(
      "click",
      () => {
        const device = this.selectedDevice();
        if (!device?.physicalDeviceId) return;
        this.beginPhysicalDeviceRevocation(device.physicalDeviceId).catch(
          (err) => {
            this.state.error = err.message;
            this.render();
          },
        );
      },
    );
    const revokeAllSiteDevicesForm = this.querySelector(
      "#revoke-all-site-devices",
    );
    const revokeAllConfirmation = revokeAllSiteDevicesForm?.querySelector(
      "#revoke-all-confirmation",
    );
    const revokeAllSubmit = revokeAllSiteDevicesForm?.querySelector(
      "button[type='submit']",
    );
    const syncRevokeAllSubmit = () => {
      if (revokeAllSubmit instanceof HTMLButtonElement) {
        revokeAllSubmit.disabled =
          String(revokeAllConfirmation?.value || "") !==
          String(this.state.site?.name || "");
      }
    };
    syncRevokeAllSubmit();
    revokeAllConfirmation?.addEventListener("input", syncRevokeAllSubmit);
    revokeAllSiteDevicesForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.revokeAllSiteDevices(event.currentTarget).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelectorAll("[data-suspend-device]").forEach((button) => {
      button.addEventListener("click", () => {
        this.beginDeviceSuspension(dataAttr(button, "data-suspend-device"));
      });
    });
    this.querySelector("#device-suspension")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        this.suspendDeviceBinding(event.currentTarget).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelector("#cancel-device-suspension")?.addEventListener(
      "click",
      () => {
        this.state.suspensionTarget = null;
        this.render();
      },
    );
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
  render() {
    const provider = this.state.provider;
    const program = this.state.program;
    const site = this.state.site;
    const siteManager = this.state.siteManager;
    const route = currentRoute();
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
      <main class="admin" id="main-content">
        <header class="admin__header">
          <div class="site-title">
            <a class="brand" href="/sites" data-route>Good Neighbor Admin</a>
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
        ${importFailureToast(this.state.importNotice)}
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
        ${this.state.error ? `<p class="error">${escapeHtml(this.state.error)}</p>` : ""}
        ${
          this.state.hasToken && !provider && !program && !site && !siteManager
            ? route.name === "administrators"
              ? administratorView(
                  this.state.adminUsers,
                  this.state.adminUserStatusFilter,
                  this.state.adminUserMessage,
                  this.state.adminUserDirectoryMode,
                )
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
        ${program ? programView(program) : ""}
        ${siteManager ? siteManagerEditorView(this.state, siteManager) : ""}
        ${
          site
            ? `
              <section class="site-page">
                <a class="site-back-link" href="/sites" data-route><span aria-hidden="true">‹</span> Site admin</a>
                <div class="panel__head">
                  <div class="site-title">
                    <h1 tabindex="-1">${escapeHtml(site.name)}</h1>
                    <p class="muted site-title__updated">
                      Last updated ${escapeHtml(formatTimestamp(site.updatedAt))}
                    </p>
                  </div>
                  <button class="btn-danger" type="button" data-deactivate-site="${escapeHtml(site.siteId)}">
                    Deactivate site
                  </button>
                </div>
                ${siteSectionNav(site.siteId, activeSiteSection)}
                ${siteSectionView(this.state, activeSiteSection, siteSubview)}
                ${deactivateSiteDialog(site.name)}
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
    if (!this.state.hasToken || capabilities.createEntities) return;
    this.querySelectorAll(
      'a[href="/sites/new"], a[href^="/providers/new"], a[href^="/programs/new"], a[href="/managers/new"], a[href="/sites/import"], [data-deactivate-provider], [data-deactivate-site], [data-remove-manager-membership], [data-remove-site-manager], [data-save-lead-program], #manager-membership-form, #provider-program-form, #new-city-program-manager-dialog',
    ).forEach((element) => element.remove());
    const leadProgram = this.querySelector('[name="lead-program-id"]');
    if (leadProgram) leadProgram.disabled = true;
  }
}

customElements.define("admin-app", AdminApp);

function adminSettingsMenu(canManageUsers, canImportSites) {
  return `<div class="admin-settings-wrap">
    <button class="admin-settings" type="button" popovertarget="admin-settings-menu" aria-label="Settings" aria-haspopup="menu">
      <wa-icon name="gear" aria-hidden="true"></wa-icon>
    </button>
    <div class="admin-settings-menu" id="admin-settings-menu" popover role="menu" aria-label="Settings">
      ${canManageUsers ? '<a href="/administrators" data-route role="menuitem"><wa-icon name="users" aria-hidden="true"></wa-icon>User management</a>' : ""}
      ${canImportSites ? '<a href="/sites/import" data-route role="menuitem"><wa-icon name="file-import" aria-hidden="true"></wa-icon>Import</a>' : ""}
      <button id="clear-token" type="button" role="menuitem"><wa-icon name="arrow-right-from-bracket" aria-hidden="true"></wa-icon>Sign out</button>
    </div>
  </div>`;
}

function administratorView(
  users,
  statusFilter = "all",
  message = "",
  directoryMode = "cognito",
) {
  const filteredUsers = users.filter(
    (user) =>
      statusFilter === "all" || adminUserLifecycleStatus(user) === statusFilter,
  );
  return `<section class="panel" aria-labelledby="administrators-title">
    <a class="site-back-link" href="/sites" data-route><span aria-hidden="true">‹</span> Site admin</a>
    <div class="panel__head"><div><h1 id="administrators-title" tabindex="-1">Manage users</h1><p class="muted">Invite, suspend, reinstate, or manage user access.</p></div></div>
    ${directoryMode === "local" ? '<p class="admin-local-directory" role="note"><strong>Local test directory.</strong> Changes reset when the backend restarts, and no emails are sent.</p>' : ""}
    ${message ? `<p class="success admin-user-toast" role="status">${escapeHtml(message)}</p>` : ""}
    <form id="admin-user-form" class="site-details-form">
      <fieldset><legend>Invite administrator</legend>
        <div class="form-grid">
          <wa-input name="firstName" label="First name" required></wa-input>
          <wa-input name="lastName" label="Last name" required></wa-input>
          <wa-input name="email" type="email" label="Work email" autocomplete="email" required></wa-input>
          <div class="admin-role-label">
            <span id="invite-admin-role-label">Role</span>
            <button class="btn-icon" id="show-admin-role-help" type="button" aria-label="Learn about user roles"><wa-icon name="circle-info" aria-hidden="true"></wa-icon></button>
          </div>
          <wa-select name="role" aria-labelledby="invite-admin-role-label" value="compliance-manager">
            <wa-option value="compliance-manager">Manager</wa-option>
            <wa-option value="compliance-supervisor">Supervisor</wa-option>
          </wa-select>
        </div>
        <button class="btn-primary admin-invite-submit" type="submit">Send invitation</button>
      </fieldset>
    </form>
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
    ${filteredUsers.length ? "" : '<p class="muted">No administrators match this status.</p>'}
    ${adminRoleHelpDialog()}
  </section>`;
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
        <h2 class="places-modal__title" id="site-unsaved-title">Discard your changes?</h2>
        <p class="places-modal__text" id="site-unsaved-copy">Your edits haven't been saved.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="keep">Keep editing</button>
        <button class="btn-danger" value="discard">Discard changes</button>
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
        <button class="btn-danger" value="confirm">Remove manager</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {string} siteName */
function deactivateSiteDialog(siteName) {
  return `<dialog id="deactivate-site-dialog" class="places-modal" aria-labelledby="deactivate-site-title" aria-describedby="deactivate-site-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="deactivate-site-title">Deactivate ${escapeHtml(siteName)}?</h2>
        <p class="places-modal__text" id="deactivate-site-copy">This will remove the site from the Sites list and update its program and manager associations. The associated program and manager records will not be removed.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Deactivate site</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
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
  if (section === "oversight")
    return `${siteOversightView(state)}${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}`;
  if (section === "compliance") {
    if (subview === "new-term") return siteComplianceTermView(state);
    return `${siteComplianceSummaryView(state)}${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}${siteTermsView(state)}${siteLettersView(state)}${sitePerimeterView(state)}`;
  }
  if (section === "access") return siteAccessView(state);
  return `${siteEditor(state)}
    ${state.siteSaveMessage ? `<p id="site-save-status" class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    `;
}

/** @param {AdminState} state */
function sitePerimeterView(state) {
  const site = /** @type {AdminSite} */ (state.site);
  const conflict = state.perimeterError.includes("Reload the latest version");
  const updatedBy = site.perimeterUpdatedBy
    ? ` by ${escapeHtml(site.perimeterUpdatedBy)}`
    : "";
  return `<section class="subsection" aria-labelledby="perimeter-title">
    <div>
      <h2 id="perimeter-title">Perimeter</h2>
      <p class="muted">Plain language description of the perimeter that staff should check.</p>
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
  return `<section class="subsection" aria-labelledby="terms-title">
    <div><h2 id="terms-title">Past compliance terms</h2><p class="muted">Adding a new compliance term generates a new draft compliance letter.</p></div>
    ${termsHistory(terms.slice(1), "No past compliance terms.")}
  </section>`;
}

function siteLettersView(state) {
  const site = state.site;
  const current = site?.complianceLetters?.current;
  const past = site?.complianceLetters?.past || [];
  return `<section class="subsection" aria-labelledby="letters-title">
    <h2 id="letters-title">Compliance letters</h2>
    <p>${current ? `Current letter: ${escapeHtml(current.fileName || current.status || "Generated")}` : "No letter has been generated yet"}</p>
    <h3>Past letters</h3>
    ${past.length ? `<ul>${past.map((letter) => `<li>${escapeHtml(letter.fileName || letter.createdAt || "Previous letter")}</li>`).join("")}</ul>` : '<p class="muted">No past letters.</p>'}
  </section>`;
}

/** @param {any[]} terms @param {string} [emptyMessage] */
function termsHistory(
  terms,
  emptyMessage = "No effective-dated terms have been added.",
) {
  if (!terms.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Starts</th><th>Expires</th><th>Tier</th><th>Checks/day</th><th>Created</th></tr></thead><tbody>${terms
    .map(
      (term) =>
        `<tr><td>${escapeHtml(term.effectiveStart)}</td><td>${escapeHtml(term.expiresOnExclusive || "No expiry")}</td><td>${escapeHtml(term.tier)}</td><td>${escapeHtml(term.requiredChecksPerDay)}</td><td>${escapeHtml(formatTimestamp(term.createdAt))}</td></tr>`,
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
  const selectableDevices = state.devices.filter(
    (device) => device.status !== "revoked" && !device.legacy,
  );
  const revocableDevices = state.devices.filter(
    (device) => device.status !== "revoked",
  );
  const hasCurrentManager = state.managerMemberships.length > 0;
  return `<section class="subsection site-access" aria-label="App access">
    <h2>Current site manager</h2>
    ${managerMembershipList(state.managerMemberships)}
    ${
      hasCurrentManager
        ? ""
        : `<form id="manager-membership-form" class="inline-form manager-membership-form">
      <wa-select name="manager-user-id" aria-label="Choose site manager" placeholder="Choose site manager">
        ${state.availableSiteUsers.map((user) => `<wa-option value="${escapeHtml(user.userId)}">${escapeHtml(`${user.firstName} ${user.lastName}`)}</wa-option>`).join("")}
      </wa-select>
      <button class="btn-primary" type="submit" hidden>Select as manager</button>
    </form>`
    }
    ${hasCurrentManager || state.availableSiteUsers.length ? "" : '<p class="muted">Assign a Lead Program and add Program staff before enrolling a Site Manager.</p>'}
    <h2>Enrollment links</h2>
    <p class="muted">Links enroll one device for this Site only and expire after 15 minutes.</p>
    ${managerEnrollmentActions(state.managerMemberships)}
    ${managerGrantList(state.managerGrants)}
    <h2>Devices</h2>
    ${revocableDevices.length ? "" : '<p class="empty-state">No devices in use.</p>'}
    ${state.revocationMessage ? `<p class="success" role="status">${escapeHtml(state.revocationMessage)}</p>` : ""}
    ${selectableDevices.length ? '<div id="device-selection-actions" class="device-selection-actions" hidden><button id="remove-device-this-site" class="btn-danger" type="button">Remove access to this site</button><button id="remove-device-all-sites" class="btn-danger" type="button">Remove access to all sites</button></div>' : ""}
    <div class="device-list">${revocableDevices.map((device) => `<div class="device-row">${device.legacy ? "" : `<wa-checkbox aria-label="Select device ${escapeHtml(shortOpaqueId(device.bindingId || device.deviceId))}" data-device-selection="${escapeHtml(device.bindingId || device.deviceId)}">Select</wa-checkbox>`}<div class="device-row__details"><strong>ID ${escapeHtml(shortOpaqueId(device.bindingId || device.deviceId))}</strong><span>Last seen ${escapeHtml(formatTimestamp(device.lastSeenAt))}</span></div></div>`).join("")}</div>
    ${deviceSuspensionForm(state.suspensionTarget)}
    ${physicalDeviceRevocationConfirmation(state.physicalDeviceRevocationPreview)}
    <form id="revoke-all-site-devices" class="inline-form destructive-confirmation"><wa-input id="revoke-all-confirmation" name="confirmation" required autocomplete="off"><span slot="label">Type <strong>${escapeHtml(state.site.name)}</strong> to revoke access for every device used on this site</span></wa-input><button class="btn-danger" type="submit" disabled>Revoke all devices at this Site</button></form>
    ${removeManagerMembershipDialog(state.managerMembershipRemovalTarget, state.site.name)}
  </section>`;
}

/** @param {any | null} preview */
function physicalDeviceRevocationConfirmation(preview) {
  if (!preview) return "";
  return `<form id="physical-device-revocation" class="site-details-form" aria-labelledby="physical-device-revocation-title">
    <fieldset>
      <legend id="physical-device-revocation-title">Remove ${escapeHtml(preview.label)} access to all sites</legend>
      <p>This permanently removes ${escapeHtml(preview.bindings.length)} active Site binding${preview.bindings.length === 1 ? "" : "s"} on this physical device:</p>
      ${preview.bindings.length ? `<ul>${preview.bindings.map((binding) => `<li>${escapeHtml(binding.siteName)} — ${escapeHtml(binding.accessLevel)}</li>`).join("")}</ul>` : "<p>No active Site bindings remain.</p>"}
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

/** @param {any[]} memberships */
function managerMembershipList(memberships) {
  if (!memberships.length) {
    return '<p class="empty-state">No site manager has been assigned. Choose one from the dropdown.</p>';
  }
  return `<ul class="contact-list">${memberships
    .map(
      (membership) => `<li>
        <div><strong>${escapeHtml(membership.name)}</strong><span><a href="mailto:${escapeHtml(membership.email)}">${escapeHtml(membership.email)}</a></span><span class="muted">Has ${escapeHtml(membership.activeBindingCount || 0)} active device${Number(membership.activeBindingCount || 0) === 1 ? "" : "s"} in use at this site</span></div>
        <div class="contact-list__actions"><button class="btn-danger" type="button" data-remove-manager-membership="${escapeHtml(membership.membershipId)}">Remove</button></div>
      </li>`,
    )
    .join("")}</ul>`;
}

/** @param {any[]} memberships */
function managerEnrollmentActions(memberships) {
  if (!memberships.length) return "";
  return `<div class="row">${memberships
    .map(
      (membership) =>
        `<button class="btn-secondary" type="button" data-issue-manager-grant="${escapeHtml(membership.membershipId)}">${memberships.length === 1 ? "Email enrollment link" : `Email enrollment link to ${escapeHtml(membership.name)}`}</button>`,
    )
    .join("")}</div>`;
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
    return '<p class="empty-state">No enrollment links issued.</p>';
  return `<details class="table-disclosure"><summary>Enrollment link history (${escapeHtml(grants.length)})</summary><div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Issued</th><th>Expires</th><th>Status</th><th>Link delivery</th><th>Security notice</th><th>Action</th></tr></thead><tbody>${grants
    .map(
      (grant) =>
        `<tr><td><span class="enrollment-recipient"><span>${escapeHtml(grant.issuedTo)}</span>${grant.enrollmentUrl ? `<button class="btn-icon enrollment-copy" type="button" title="Copy enrollment link" aria-label="Copy enrollment link for ${escapeHtml(grant.issuedTo)}" data-copy-enrollment-url="${escapeHtml(grant.enrollmentUrl)}"><wa-icon name="copy" aria-hidden="true"></wa-icon></button><span class="visually-hidden" aria-live="polite" data-copy-status></span>` : ""}</span></td><td>${escapeHtml(formatTimestamp(grant.createdAt))}</td><td>${escapeHtml(formatTimestamp(grant.expiresAt))}</td><td>${escapeHtml(grant.status)}</td><td>${escapeHtml(grant.deliveryStatus || "queued")}</td><td>${escapeHtml(grant.securityNotificationStatus || (grant.status === "redeemed" ? "pending" : "Not applicable"))}</td><td>${grant.status === "pending" ? `<button class="btn-danger" type="button" data-cancel-manager-grant="${escapeHtml(grant.grantId)}">Cancel</button>` : "—"}</td></tr>`,
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
  const section = route.name.startsWith("manager")
    ? "managers"
    : route.name.startsWith("provider") || route.name === "programs"
      ? "providers"
      : "sites";
  const params = new URLSearchParams(window.location.search);
  const search = params.get("q") || "";
  const filterParams = {
    manager: params.get("manager") || "",
    department: params.get("department") || "",
    system: params.get("system") || "",
  };
  return `<section class="directory" aria-labelledby="directory-title">
    <div class="page-head">
      <div>
        <h1 id="directory-title" tabindex="-1">Site admin</h1>
        <p class="muted">Manage providers, programs, sites, enrollment, and devices.</p>
      </div>
    </div>
    <form id="directory-search" class="directory-search" role="search">
      <label class="visually-hidden" for="directory-search-input">Search providers, programs, sites, or managers</label>
      <div class="directory-search__controls">
        <wa-input id="directory-search-input" name="q" type="search" value="${escapeHtml(search)}" placeholder="Search providers, programs, sites, or managers" aria-label="Search providers, programs, sites, or managers" pill with-clear><wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon></wa-input>
        <button class="btn-secondary" type="submit">Search</button>
        ${search ? '<button class="btn-link" id="clear-directory-search" type="button">Clear</button>' : ""}
      </div>
    </form>
    <nav class="entity-tabs" aria-label="Site administration sections">
      ${directoryTab("sites", "Sites", section, search)}
      ${directoryTab("managers", "Site managers", section, search)}
      ${directoryTab("providers", "Providers & Programs", section, search)}
    </nav>
    ${search && section !== "managers" ? globalDirectorySearch(state, search) : ""}
    ${!search && section === "sites" ? siteDirectory(state, filterParams) : ""}
    ${!search && section === "providers" ? providerDirectory(state.providers) : ""}
    ${section === "managers" ? siteManagerDirectory(state, { program: params.get("program") || "", site: params.get("site") || "" }, search) : ""}
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
  const options = (field) =>
    [
      ...new Set(sites.map((site) => site.oversight?.[field]).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
  const filtered = sites
    .filter(
      (site) =>
        (!selected.manager ||
          site.oversight?.cityProgramManager === selected.manager) &&
        (!selected.department ||
          site.oversight?.managingCityDepartment === selected.department) &&
        (!selected.system ||
          site.oversight?.managingSystemOfCare === selected.system),
    )
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `<section class="site-directory" aria-labelledby="sites-title">
    <div class="panel__head">
      <div>
        <h2 id="sites-title">Sites</h2>
        <p class="muted">${filtered.length} ${filtered.length === 1 ? "site" : "sites"}</p>
      </div>
      <a class="btn-link" href="/sites/new" data-route>Add new site</a>
    </div>
    <form id="site-directory-filters" class="directory-filters" aria-label="Filter sites">
      ${filterSelect("manager", "All program managers", options("cityProgramManager"), selected.manager)}
      ${filterSelect("department", "All departments", options("managingCityDepartment"), selected.department)}
      ${filterSelect("system", "All systems of care", options("managingSystemOfCare"), selected.system)}
    </form>
    ${
      filtered.length
        ? `<ul class="site-directory-list">${filtered
            .map((site) => {
              const managerName =
                site.managerMemberships?.[0]?.name ||
                [site.primaryContact?.firstName, site.primaryContact?.lastName]
                  .filter(Boolean)
                  .join(" ");
              const manager = managerName || "Site manager not assigned";
              const leadProgramName =
                site.programName ||
                state.programs.find(
                  (program) => program.programId === site.leadProgramId,
                )?.name;
              return `<li><a class="site-directory-row" href="/sites/${encodeURIComponent(site.siteId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(site.name || site.siteName || site.siteId)}</strong><span>${escapeHtml(leadProgramName || "No lead program assigned")} · ${escapeHtml(manager)}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`;
            })
            .join("")}</ul>`
        : '<p class="muted">No sites match these filters.</p>'
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
      <div><h2 id="managers-title">Site managers</h2><p class="muted">${managers.length} ${managers.length === 1 ? "manager" : "managers"}</p></div>
      <a class="btn-link" href="/managers/new" data-route>Add new manager</a>
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
  return `<section class="panel" aria-label="Search results"><h2>Search results</h2>
    ${searchResultList(
      "Sites",
      sites,
      (site) => `/sites/${encodeURIComponent(site.siteId)}`,
      (site) => site.name || site.siteName,
    )}
    ${searchResultList(
      "Programs",
      programs,
      (program) => `/providers/${encodeURIComponent(program.providerId)}`,
      (program) =>
        `${program.name} — ${program.providerName || "Open provider"}`,
    )}
    ${searchResultList(
      "Providers",
      providers,
      (provider) => `/providers/${encodeURIComponent(provider.providerId)}`,
      (provider) => provider.name,
    )}
    ${sites.length + programs.length + providers.length === 0 ? '<p class="muted">No matching sites, programs, or providers.</p>' : ""}
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
    <a class="site-back-link" href="/sites" data-route><span aria-hidden="true">‹</span> Site admin</a>
    <div class="page-head"><div><h1 id="import-title" tabindex="-1">Import sites</h1><p class="muted">Upload a CSV file of sites, providers, programs, and contact details.</p></div></div>
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
function importFailureToast(notice) {
  if (!notice) return "";
  return `<section class="admin-toast admin-toast--error" role="alert" aria-atomic="true">
    <wa-icon name="triangle-exclamation" aria-hidden="true"></wa-icon>
    <div><p class="admin-toast__title">${escapeHtml(notice.title)}</p><p class="admin-toast__message">${escapeHtml(notice.message)}</p></div>
    <button class="btn-icon admin-toast__close" id="dismiss-import-notice" type="button" aria-label="Dismiss import failure notification"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
  </section>`;
}

function siteImportHelpDialog() {
  return `<dialog id="site-import-help-dialog" class="places-modal" aria-labelledby="site-import-help-title">
    <form class="places-modal__card import-help" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="site-import-help-title">CSV upload requirements</h2>
        <div class="import-help__body">
          <p>Upload a UTF-8 CSV no larger than 1 MB or 500 data rows.</p>
          <p>The first row must contain these columns in this exact order:</p>
          <p class="column-list"><code>Provider</code>, <code>Program</code>, <code>Site name</code>, <code>Site address</code>, <code>Contact first name</code>, <code>Contact last name</code>, <code>Contact phone</code>, <code>Contact extension</code>, <code>Contact email</code>.</p>
          <p><strong>Contact phone</strong> and <strong>Contact extension</strong> may be blank. All other fields are required.</p>
          <p>Use one site and contact assignment per row. Put values containing commas in double quotes.</p>
        </div>
      </div>
      <div class="places-modal__actions"><button class="btn-primary" value="close">Close</button></div>
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
    <a href="${inSiteFlow ? "/sites/new" : "/providers"}" data-route class="site-back-link"><span aria-hidden="true">‹</span> ${inSiteFlow ? "Add new site" : "Providers"}</a>
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
    <a href="${inSiteFlow ? `/sites/new${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}` : inProviderFlow && providerId ? `/providers/${encodeURIComponent(providerId)}` : "/programs"}" data-route class="site-back-link"><span aria-hidden="true">‹</span> ${inSiteFlow ? "Add new site" : inProviderFlow ? "Provider" : "Site admin"}</a>
    <div><h1 id="new-program-title" tabindex="-1">Add new program</h1><p class="muted">Create the Program and its first staff member. ${inSiteFlow ? "You’ll return to the new Site flow afterward." : inProviderFlow ? "You’ll return to the provider afterward." : ""}</p></div>
    <form id="program-form" class="site-details-form">
      <fieldset><legend>Program</legend><div class="form-grid form-grid--one">
        ${formInput("program-name", "Program name", "", { required: true, autocomplete: "organization" })}
        <wa-select name="program-provider" label="Provider" required placeholder="Choose a provider">
          ${state.providers.map((provider) => `<wa-option value="${escapeHtml(provider.providerId)}" ${provider.providerId === providerId ? "selected" : ""}>${escapeHtml(provider.name)}</wa-option>`).join("")}
        </wa-select>
      </div></fieldset>
      <fieldset><legend>Assign staff</legend><p class="muted">Add the first staff contact for this Program.</p><div class="form-grid form-grid--two">
        ${formInput("contact-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
        ${formInput("contact-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
        ${formInput("contact-phone", "Phone", "", { required: true, type: "tel", autocomplete: "tel" })}
        ${formInput("contact-email", "Email", "", { required: true, type: "email", autocomplete: "email" })}
      </div></fieldset>
      <button class="btn-primary" type="submit">Add program</button>
    </form>
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
    <a href="/sites" data-route class="site-back-link"><span aria-hidden="true">‹</span> Site admin</a>
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
        ${requiredFlowInput("public-contact-phone", "Phone", { type: "tel", autocomplete: "tel", pattern: "[0-9()+ .-]{10,20}" })}
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
      <div><h2 id="providers-title">Providers &amp; Programs</h2>
      <p class="muted">Open a provider to see its associated programs</p>
      <p class="muted">${active.length} ${active.length === 1 ? "provider" : "providers"}</p></div>
      <a class="btn-link" href="/providers/new" data-route>Add new provider</a>
    </div>
    ${active.length ? `<ul class="site-directory-list">${active.map((provider) => `<li><a class="site-directory-row" href="/providers/${encodeURIComponent(provider.providerId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(provider.name)}</strong><span>Provider</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : '<p class="muted">No providers have been added.</p>'}
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
  if (!items.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
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
  const canManageAssignments = state.capabilities.createEntities === true;
  const assignmentDisabled = canManageAssignments ? "" : "disabled";
  const programId = manager?.programId || "";
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
    <a class="site-back-link" href="/managers" data-route><span aria-hidden="true">‹</span> Site managers</a>
    <div class="panel__head">
      <h1 id="manager-record-title" tabindex="-1">${escapeHtml(title)}</h1>
      ${isNew ? "" : '<button class="btn-danger" type="button" data-remove-site-manager>Remove manager</button>'}
    </div>
    <form id="site-manager-record-form" class="site-details-form" data-dirty-form>
      <fieldset>
        <legend>Manager details</legend>
        <wa-select name="manager-program-id" label="Program" placeholder="Choose a program" required ${assignmentDisabled}>${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}" ${program.programId === programId ? "selected" : ""}>${escapeHtml(program.name)}</wa-option>`).join("")}</wa-select>
        <p class="field-help">Changing the Program changes which Sites can be assigned.</p>
        <div class="form-grid form-grid--one">
          ${formInput("manager-first-name", "First name", manager?.firstName || "", { required: true, autocomplete: "given-name" })}
          ${formInput("manager-last-name", "Last name", manager?.lastName || "", { required: true, autocomplete: "family-name" })}
          ${formInput("manager-phone", "Contact phone", manager?.phone || "", { required: true, type: "tel", autocomplete: "tel" })}
          ${formInput("manager-phone-extension", "Contact phone extension", manager?.phoneExtension || "", { autocomplete: "tel-extension" })}
          ${formInput("manager-email", "Contact email", manager?.email || "", { required: true, type: "email", autocomplete: "email", disabled: !canManageAssignments })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Assigned sites</legend>
        <p class="muted">A manager can be assigned only to Sites led by their Program.</p>
        <div class="manager-site-options">
          ${sites
            .map((site) => {
              const matches = site.leadProgramId === programId;
              return `<label class="manager-site-option" data-manager-site-program="${escapeHtml(site.leadProgramId || "")}" ${matches ? "" : "hidden"}><wa-checkbox name="manager-site-id" value="${escapeHtml(site.siteId)}" ${assigned.has(site.siteId) ? "checked" : ""} ${matches && canManageAssignments ? "" : "disabled"}>${escapeHtml(siteLabel(site))}</wa-checkbox></label>`;
            })
            .join("")}
          <p class="empty-state" data-manager-sites-empty ${programId && sites.some((site) => site.leadProgramId === programId) ? "hidden" : ""}>${programId ? "This Program has no Sites to assign." : "Choose a Program to see available Sites."}</p>
        </div>
      </fieldset>
      ${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
      <button class="btn-primary" type="submit" data-save-button disabled>${isNew ? "Add manager" : "Save changes"}</button>
    </form>
    ${isNew ? "" : `${managerProgramChangeDialog()}${removeSiteManagerDialog(title)}`}
    ${discardChangesDialog()}
  </section>`;
}

function siteLabel(site) {
  return site.name || site.siteName || site.siteId || "Site";
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
  return `<section class="site-page" aria-labelledby="provider-title">
    <a class="site-back-link" href="/providers" data-route><span aria-hidden="true">‹</span> Site admin</a>
    <div class="panel__head">
      <h1 id="provider-title" tabindex="-1">${escapeHtml(provider.name)}</h1>
      <button class="btn-danger" type="button" data-deactivate-provider="${escapeHtml(provider.providerId)}">Deactivate provider</button>
    </div>
    <form id="provider-details-form" class="site-details-form" data-dirty-form>
      ${formInput("provider-name", "Provider name", provider.name, { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit" data-save-button disabled>Save changes</button>
    </form>
    ${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    <section class="subsection" aria-labelledby="provider-programs-title">
      <div class="panel__head">
        <h2 id="provider-programs-title">Programs</h2>
        <a class="btn-link" href="/programs/new?providerId=${encodeURIComponent(provider.providerId)}&returnTo=provider" data-route>Create a new program</a>
      </div>
      <form id="provider-program-form" class="inline-form">
        <wa-select name="program-id" label="Add program" required placeholder="Choose a program">
          ${availablePrograms.map((program) => `<wa-option value="${escapeHtml(program.programId)}">${escapeHtml(program.name)}</wa-option>`).join("")}
        </wa-select>
        <button class="btn-primary" type="submit" data-add-program-button disabled>Add program</button>
      </form>
      ${availablePrograms.length ? "" : '<p class="muted">Every active Program is already linked to this provider.</p>'}
      ${linkedPrograms.length ? `<ul class="site-directory-list">${linkedPrograms.map((program) => `<li><a class="site-directory-row" href="/programs/${encodeURIComponent(program.programId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(program.name)}</strong><span>Program</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : '<p class="muted">No programs are linked to this provider.</p>'}
    </section>
    ${deactivateProviderDialog(provider.name)}
  </section>`;
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
function programView(program) {
  const contact = program.contact || {};
  const contactName = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(" ");
  const siteManagers = (program.users || [])
    .filter((user) => user.status !== "inactive" && user.siteManager === true)
    .sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      ),
    );
  return `<section class="site-page">
    <a class="site-back-link" href="/programs" data-route><span aria-hidden="true">‹</span> Site admin</a>
    <div class="panel__head">
      <div>
        <h1 tabindex="-1">${escapeHtml(program.name)}</h1>
        <p class="muted"><a href="/providers/${encodeURIComponent(program.providerId)}" data-route>${escapeHtml(program.providerName || "Provider")}</a></p>
      </div>
      ${program.needsReview ? '<span class="status-badge">Needs review</span>' : '<span class="status-badge">Active</span>'}
    </div>
    <section class="subsection" aria-labelledby="program-primary-contact-title">
      <div class="panel__head">
        <h2 id="program-primary-contact-title">Primary contact</h2>
        <button class="btn-secondary" id="edit-program-contact" type="button">Edit</button>
      </div>
      <dl class="detail-list">
        <div><dt>Name</dt><dd>${escapeHtml(contactName || "Not assigned")}</dd></div>
        <div><dt>Email</dt><dd>${contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : "Not provided"}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(contact.phone || "Not provided")}</dd></div>
      </dl>
    </section>
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
    <section class="subsection" aria-labelledby="program-site-managers-title">
      <h2 id="program-site-managers-title">Site managers</h2>
      ${
        siteManagers.length
          ? `<ul class="site-directory-list">${siteManagers
              .map(
                (manager) =>
                  `<li><a class="site-directory-row" href="/managers/${encodeURIComponent(manager.userId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(`${manager.firstName} ${manager.lastName}`.trim())}</strong><span>${escapeHtml(manager.email || "Email not provided")} · ${Number(manager.siteAssignmentCount || 0)} ${Number(manager.siteAssignmentCount || 0) === 1 ? "site" : "sites"}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`,
              )
              .join("")}</ul>`
          : '<p class="empty-state">No site managers are associated with this Program.</p>'
      }
    </section>
    ${programContactDialog(contact)}
  </section>`;
}

/** @param {Record<string, any>} contact */
function programContactDialog(contact) {
  return `<dialog id="program-contact-dialog" class="places-modal" aria-labelledby="program-contact-dialog-title">
    <form id="program-contact-form" class="places-modal__card site-details-form">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="program-contact-dialog-title">Edit primary contact</h2>
        <div class="form-grid form-grid--two">
          ${formInput("program-contact-first-name", "First name", contact.firstName || "", { autocomplete: "given-name" })}
          ${formInput("program-contact-last-name", "Last name", contact.lastName || "", { autocomplete: "family-name" })}
          ${formInput("program-contact-phone", "Phone", contact.phone || "", { type: "tel", autocomplete: "tel" })}
          ${formInput("program-contact-email", "Email", contact.email || "", { type: "email", autocomplete: "email" })}
        </div>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">Save contact</button>
        <button class="btn-outline" id="cancel-program-contact" type="button">Cancel</button>
      </div>
    </form>
  </dialog>`;
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
  const programs = state.programs.filter(
    (program) => program.status !== "inactive",
  );
  const staff = state.availableSiteUsers.filter(
    (user) => user.status !== "inactive",
  );
  const siteManagerUnavailableMessage = !site.leadProgramId
    ? "Assign a lead program first"
    : !staff.length
      ? "Add staff to the program first"
      : "";
  const hasAddress = Boolean(site.address || streetLineFromParts(address));
  return `<form id="site-details-form" class="site-details-form" data-dirty-form>
    <fieldset>
      <legend>Site name and public contact</legend>
      <div class="form-grid form-grid--one" data-site-details-fields>
        ${formInput("site-name", "Site name", site.name, { required: true, autocomplete: "organization" })}
        <div class="form-grid form-grid--two">
          ${formInput("public-contact-email", "Public contact email", publicContact.email, { type: "email", autocomplete: "email" })}
          ${formInput("public-contact-phone", "Public contact phone", publicContact.phone, { type: "tel", autocomplete: "tel", pattern: "(?:\\+?1[ .-]?)?\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}" })}
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
      <legend>Lead program</legend>
      <div class="form-grid form-grid--one">
        <wa-select name="lead-program-id" aria-label="Lead program" placeholder="No lead program assigned" data-initial-value="${escapeHtml(site.leadProgramId || "")}">
          <wa-option value="" ${site.leadProgramId ? "" : "selected"}>No lead program assigned</wa-option>
          ${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}" ${program.programId === site.leadProgramId ? "selected" : ""}>${escapeHtml(program.name)}</wa-option>`).join("")}
        </wa-select>
        <button class="btn-primary" type="button" data-save-lead-program disabled>Save lead program</button>
      </div>
    </fieldset>
    <fieldset>
      <legend>Site manager</legend>
      <wa-select name="site-manager-user-id" aria-label="Site manager" placeholder="Choose program staff" data-initial-value="${escapeHtml(site.primaryContactUserId || "")}" ${siteManagerUnavailableMessage ? "disabled" : ""}><span slot="label" data-site-manager-label>${siteManagerUnavailableMessage || "Lead Program staff member"}</span>
        ${staff.map((user) => `<wa-option value="${escapeHtml(user.userId)}" ${user.userId === site.primaryContactUserId ? "selected" : ""}>${escapeHtml(`${user.firstName} ${user.lastName}`)}</wa-option>`).join("")}
      </wa-select>
      <div id="site-manager-contact-details">${siteManagerContactDetails(staff.find((user) => user.userId === site.primaryContactUserId))}</div>
      <button class="btn-primary" type="button" data-save-site-manager disabled>Save site manager</button>
    </fieldset>
    ${state.siteSaveError ? `<p id="site-save-error" class="error site-details-form__message" role="alert">${escapeHtml(state.siteSaveError)}</p>` : ""}
  </form>
  ${leadProgramConfirmationDialog()}
  ${siteManagerConfirmationDialog()}`;
}

function leadProgramConfirmationDialog() {
  return `<dialog id="lead-program-confirmation-dialog" class="places-modal" aria-labelledby="lead-program-confirmation-title" aria-describedby="lead-program-confirmation-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="lead-program-confirmation-title">Save lead program change?</h2>
        <p class="places-modal__text" id="lead-program-confirmation-copy">This will move the site to the selected lead program. The available site managers will change to that program's staff.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" value="confirm">Save lead program</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function siteManagerConfirmationDialog() {
  return `<dialog id="site-manager-confirmation-dialog" class="places-modal" aria-labelledby="site-manager-confirmation-title" aria-describedby="site-manager-confirmation-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="site-manager-confirmation-title">Save site manager change?</h2>
        <p class="places-modal__text" id="site-manager-confirmation-copy">This will assign the selected staff member as the site's manager.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" value="confirm">Save site manager</button>
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
      <button class="btn-link address-manual" type="button" aria-controls="manual-address-fields" aria-expanded="false" data-enter-address-manually>Enter address manually</button>
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

function oversightCreationDialogs() {
  return `<dialog id="new-city-program-manager-dialog" class="site-unsaved-dialog" aria-labelledby="new-city-program-manager-title">
    <form id="new-city-program-manager-form" class="site-unsaved-dialog__card site-details-form">
      <h2 id="new-city-program-manager-title">Add a new City program manager</h2>
      <p class="muted">The manager will be added to the City administrator directory and marked as a Program manager.</p>
      <div class="form-grid form-grid--two">
        ${formInput("manager-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
        ${formInput("manager-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
      </div>
      ${formInput("manager-email", "City email", "", { required: true, type: "email", autocomplete: "email" })}
      <div class="site-unsaved-dialog__actions">
        <button class="btn-secondary" type="button" data-close-dialog>Cancel</button>
        <button class="btn-primary" type="submit" data-save-button>Add manager</button>
      </div>
    </form>
  </dialog>
  <dialog id="new-oversight-option-dialog" class="site-unsaved-dialog" aria-labelledby="new-oversight-option-title">
    <form id="new-oversight-option-form" class="site-unsaved-dialog__card site-details-form">
      <h2 id="new-oversight-option-title" data-option-title>Add a new oversight option</h2>
      <input type="hidden" name="option-type" />
      <wa-input name="option-name" label="Name" required autocomplete="organization" data-option-input></wa-input>
      <div class="site-unsaved-dialog__actions">
        <button class="btn-secondary" type="button" data-close-dialog>Cancel</button>
        <button class="btn-primary" type="submit" data-save-button>Add</button>
      </div>
    </form>
  </dialog>`;
}

function siteOversightView(state) {
  const oversight = state.site?.oversight || {};
  const department = normalizeDepartment(oversight.managingCityDepartment);
  const managers = state.programManagers || [];
  const managerValue = managers.some(
    (manager) => manager.userId === oversight.cityProgramManagerId,
  )
    ? oversight.cityProgramManagerId
    : managers.find((manager) => manager.name === oversight.cityProgramManager)
        ?.userId || (oversight.cityProgramManager ? "legacy-existing" : "");
  const departments = uniqueNamedOptions([
    ...state.oversightOptions.departments,
    { name: "DPH" },
    { name: "HSH" },
    ...(department ? [{ name: department }] : []),
  ]);
  const systemsOfCare = uniqueNamedOptions([
    ...state.oversightOptions.systemsOfCare,
    { name: "BHS-PBH" },
    ...(oversight.managingSystemOfCare
      ? [{ name: oversight.managingSystemOfCare }]
      : []),
  ]);
  return `<form id="site-oversight-form" class="site-details-form" data-dirty-form>
    <fieldset><legend>Oversight</legend><div class="form-grid form-grid--one">
      <wa-select name="program-manager-id" label="City program manager" placeholder="Choose City program manager">
        ${managers.map((manager) => `<wa-option value="${escapeHtml(manager.userId)}" ${manager.userId === managerValue ? "selected" : ""}>${escapeHtml(manager.name)}</wa-option>`).join("")}
        ${managerValue === "legacy-existing" ? `<wa-option value="legacy-existing" selected>${escapeHtml(oversight.cityProgramManager)}</wa-option>` : ""}
        <wa-option value="__add_manager__" data-add-option>Add a new City program manager…</wa-option>
      </wa-select>
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
  ${oversightCreationDialogs()}`;
}

function siteComplianceSummaryView(state) {
  const sortedTerms = [...state.siteTerms].sort((a, b) =>
    String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
  );
  const latestTerms = sortedTerms[0];
  const siteId = state.site?.siteId || "";
  const newTermPath = `/sites/${encodeURIComponent(siteId)}?section=compliance&view=new-term`;
  return `<section class="site-details-form" aria-labelledby="compliance-title">
    <h2 id="compliance-title">Current compliance term</h2>
    ${termsHistory(latestTerms ? [latestTerms] : [], "No current compliance term has been saved.")}
    <div>
      <button class="btn-primary" type="button" data-navigate="${escapeHtml(newTermPath)}">Add a new compliance term</button>
    </div>
  </section>`;
}

function siteComplianceTermView(state) {
  const sortedTerms = [...state.siteTerms].sort((a, b) =>
    String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
  );
  const latestTerms = sortedTerms[0];
  const siteId = state.site?.siteId || "";
  return `<section class="compliance-term-view" aria-labelledby="new-compliance-term-title">
    <a class="site-back-link" href="/sites/${encodeURIComponent(siteId)}?section=compliance" data-route><span aria-hidden="true">‹</span> Compliance</a>
    <h2 id="new-compliance-term-title">Add a new compliance term</h2>
    <form id="site-compliance-form" class="site-details-form" data-dirty-form>
      <fieldset>
        <legend class="visually-hidden">New compliance term</legend>
      <div class="form-grid form-grid--one">
        <wa-select name="terms-tier" label="Choose tier" required placeholder="Choose tier">
          ${[0, 1, 2, 3, 4].map((tier) => `<wa-option value="${tier}" ${tier === Number(latestTerms?.tier || 0) ? "selected" : ""}>${tier === 0 ? "Tier 0 — No enhanced monitoring" : `Tier ${tier}`}</wa-option>`).join("")}
        </wa-select>
        ${formInput("terms-start", "Start date", firstDayOfNextMonth(), { type: "date", required: true })}
        ${formInput("terms-expiry", "End date (exclusive; leave blank for indefinite)", "", { type: "date" })}
        <wa-number-input id="terms-checks-per-day" name="terms-checks-per-day" label="Required checks per day" min="0" max="100" step="1" value="${escapeHtml(latestTerms?.requiredChecksPerDay ?? 0)}" required></wa-number-input>
      </div>
      </fieldset>
      <button class="btn-primary" type="submit" data-save-button disabled>Save new compliance term</button>
    </form>
  </section>`;
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
  form.dataset.isDirty = String(snapshot !== form.dataset.initialValues);
  const saveButton = form.querySelector("[data-save-button]");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = snapshot === form.dataset.initialValues;
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
    details: ["site-name", "public-contact-email", "public-contact-phone"],
    address: ["street-address", "city", "state", "zip"],
    leadProgram: ["lead-program-id"],
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
            : String(control?.value || ""),
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
  const isDirty = Object.entries(dirty).some(
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
      control.disabled = !dirty[name] || !editedSections.has(name);
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
  if (!event.isTrusted) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const name = target.getAttribute("name") || "";
  const section = {
    "site-name": "details",
    "public-contact-email": "details",
    "public-contact-phone": "details",
    "address-query": "address",
    "street-address": "address",
    city: "address",
    state: "address",
    zip: "address",
    "lead-program-id": "leadProgram",
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
}

/** @param {unknown} value */
function splitPersonName(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return { firstName: parts.shift() || "", lastName: parts.join(" ") };
}

/** @param {unknown} value */
function normalizeDepartment(value) {
  const department = String(value || "").trim();
  if (!department) return "";
  const uppercase = department.toUpperCase();
  return uppercase === "HSH" || uppercase.includes("HOMELESS")
    ? "HSH"
    : uppercase === "DPH" || uppercase.includes("PUBLIC HEALTH")
      ? "DPH"
      : department;
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
  if (code === "invalid_compliance") {
    return "Check the compliance tier, dates, and required checks per day.";
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
  return "The site couldn't be saved. Try again.";
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
