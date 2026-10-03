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

/**
 * @typedef {ReturnType<typeof getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, siteName?: string, name?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number>, perimeter?: string, perimeterUpdatedAt?: string, perimeterUpdatedBy?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ email: string, emailHash: string, name?: string, status?: string }} AdminContact
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {object} AdminState
 * @property {AdminProvider[]} providers
 * @property {any[]} programs
 * @property {any | null} program
 * @property {AdminProvider | null} provider
 * @property {AdminSite | null} site
 * @property {any[]} assignedUsers
 * @property {any[]} availableSiteUsers
 * @property {any[]} siteTerms
 * @property {AdminContact[]} contacts
 * @property {AdminDevice[]} devices
 * @property {AdminIssuedCode | null} issuedCode
 * @property {string} siteSaveMessage
 * @property {string} siteSaveError
 * @property {boolean} siteSaving
 * @property {string} error
 * @property {boolean} hasToken
 * @property {AdminConfig} authConfig
 * @property {boolean} authBusy
 * @property {any | null} importPreview
 * @property {any | null} importResult
 * @property {boolean} importBusy
 * @property {string} importApplyKey
 * @property {boolean} perimeterSaving
 * @property {string} perimeterMessage
 * @property {string} perimeterError
 */

class AdminApp extends HTMLElement {
  constructor() {
    super();
    /** @type {AdminState} */
    this.state = {
      providers: [],
      programs: [],
      program: null,
      provider: null,
      site: null,
      assignedUsers: [],
      availableSiteUsers: [],
      siteTerms: [],
      contacts: [],
      devices: [],
      issuedCode: null,
      siteSaveMessage: "",
      siteSaveError: "",
      siteSaving: false,
      error: "",
      hasToken: false,
      authConfig: getAdminConfig(),
      authBusy: false,
      importPreview: null,
      importResult: null,
      importBusy: false,
      importApplyKey: "",
      perimeterSaving: false,
      perimeterMessage: "",
      perimeterError: "",
    };
  }

  /**
   * Initialize admin auth state and load provider data when signed in.
   * @returns {Promise<void>}
   */
  async connectedCallback() {
    this.state = {
      providers: [],
      programs: [],
      program: null,
      provider: null,
      site: null,
      assignedUsers: [],
      availableSiteUsers: [],
      siteTerms: [],
      contacts: [],
      devices: [],
      issuedCode: null,
      siteSaveMessage: "",
      siteSaveError: "",
      siteSaving: false,
      error: "",
      hasToken: hasAdminSession(),
      authConfig: getAdminConfig(),
      authBusy: false,
      importPreview: null,
      importResult: null,
      importBusy: false,
      importApplyKey: "",
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
    if (this.state.hasToken) {
      this.loadDirectory().catch((error) => {
        this.state.error = error.message;
        this.render();
      });
    }
  }

  disconnectedCallback() {
    window.removeEventListener("popstate", this.routeChanged);
  }

  routeChanged = () => {
    this.openRoute().catch((error) => {
      this.state.error = error.message;
      this.render();
    });
  };

  async loadDirectory() {
    const [providers, programs] = await Promise.all([
      adminApi.listProviders(),
      adminApi.listPrograms(),
    ]);
    this.state.providers = providers.providers || [];
    this.state.programs = programs.programs || [];
    await this.openRoute();
  }

  async openRoute() {
    const route = currentRoute();
    if (route.name === "site-import") return this.openSiteImport();
    if (route.name === "provider") return this.openProvider(route.id, false);
    if (route.name === "program") return this.openProgram(route.id, false);
    if (route.name === "site") return this.openSite(route.id, false);
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  async openSiteImport() {
    const importId = new URLSearchParams(window.location.search).get(
      "importId",
    );
    if (importId && this.state.importPreview?.importId !== importId) {
      const result = await adminApi.getSiteImport(importId);
      this.state.importPreview = {
        importId,
        previewVersion: result.import.previewVersion,
        previewExpiresAt: result.import.previewExpiresAt,
        counts: result.import.counts,
        rows: result.rows,
      };
      this.state.importResult =
        result.import.status === "complete"
          ? { outcomes: result.import.outcomes || {} }
          : null;
      this.state.importApplyKey =
        sessionStorage.getItem(`site-import-key:${importId}`) ||
        result.import.idempotencyKey ||
        crypto.randomUUID();
      sessionStorage.setItem(
        `site-import-key:${importId}`,
        this.state.importApplyKey,
      );
    }
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
    await adminApi.createProvider(String(name));
    form.reset();
    await this.loadProviders();
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
    this.state.contacts = [];
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
    navigate(`/programs/${encodeURIComponent(result.program.programId)}`);
  }

  async createProgramUser(form) {
    if (!this.state.program) return;
    const data = new FormData(form);
    await adminApi.createProgramUser(this.state.program.programId, {
      firstName: formValue(data, "user-first-name"),
      lastName: formValue(data, "user-last-name"),
      phone: formValue(data, "user-phone"),
      email: formValue(data, "user-email"),
    });
    form.reset();
    await this.openProgram(this.state.program.programId, false);
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
   * Create a site under the currently open provider.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async createSite(form) {
    const data = new FormData(form);
    const name = data.get("site-name");
    const address = data.get("site-address");
    const leadProgramId = data.get("lead-program-id");
    if (!name || !address || !this.state.provider) return;
    await adminApi.createSite(this.state.provider.providerId, {
      name: String(name),
      address: String(address),
      leadProgramId: String(leadProgramId || ""),
    });
    form.reset();
    await this.openProvider(this.state.provider.providerId);
  }

  /** @param {HTMLFormElement} form */
  async updateSite(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    const name = formValue(data, "site-name");
    const addressParts = {
      streetNumber: formValue(data, "street-number"),
      streetAddress: formValue(data, "street-address"),
      secondLine: formValue(data, "address-second-line"),
      city: formValue(data, "city"),
      state: formValue(data, "state"),
      zip: formValue(data, "zip"),
    };
    const contactPerson = {
      firstName: formValue(data, "contact-first-name"),
      lastName: formValue(data, "contact-last-name"),
      email: formValue(data, "contact-email"),
      phone: formValue(data, "contact-phone"),
    };
    const oversight = {
      managingCityDepartment: formValue(data, "managing-city-department"),
      managingSystemOfCare: formValue(data, "managing-system-of-care"),
      cityProgramManagerFirstName: formValue(
        data,
        "program-manager-first-name",
      ),
      cityProgramManagerLastName: formValue(data, "program-manager-last-name"),
    };
    const complianceValues = {
      currentTier: formValue(data, "current-tier"),
      periodStart: formValue(data, "tier-period-start"),
      periodEnd: formValue(data, "tier-period-end"),
      requiredChecksPerDay: formValue(data, "required-checks-per-day"),
    };
    /** @type {Record<string, unknown>} */
    const values = { name };
    if (this.state.site.addressParts || hasEnteredValues(addressParts)) {
      values.addressParts = addressParts;
    }
    if (this.state.site.contactPerson || hasEnteredValues(contactPerson)) {
      values.contactPerson = contactPerson;
    }
    if (this.state.site.oversight || hasEnteredValues(oversight)) {
      values.oversight = oversight;
    }
    if (this.state.site.compliance || hasEnteredValues(complianceValues)) {
      values.compliance = {
        currentTier: Number(complianceValues.currentTier),
        periodStart: complianceValues.periodStart,
        periodEnd: complianceValues.periodEnd,
        requiredChecksPerDay: Number(complianceValues.requiredChecksPerDay),
      };
    }
    const letter = data.get("compliance-letter");
    this.state.siteSaving = true;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.error = "";
    this.render();
    try {
      if (letter instanceof File && letter.size > 0) {
        if (
          (letter.type && letter.type !== "application/pdf") ||
          !letter.name.toLowerCase().endsWith(".pdf") ||
          letter.size > 10 * 1024 * 1024
        ) {
          throw new Error("invalid_compliance_letter");
        }
        const upload = await adminApi.presignComplianceLetter(
          this.state.site.siteId,
          letter,
        );
        await adminApi.uploadComplianceLetter(upload.uploadUrl, letter);
        values.complianceLetter = {
          s3Key: upload.s3Key,
          fileName: letter.name,
          effectiveStart: todayIsoDate(),
        };
      }
      const result = await adminApi.updateSite(this.state.site.siteId, values);
      const location = result.site?.location;
      this.state.site = {
        ...this.state.site,
        ...result.site,
        name,
        location,
      };
      if (values.addressParts && !hasSiteCoordinates(location)) {
        this.state.siteSaveError =
          "The address was saved, but geocoding did not return coordinates. Try saving it again.";
        return;
      }
      this.state.siteSaveMessage = "Site saved successfully.";
    } catch (error) {
      this.state.siteSaveError = siteSaveErrorMessage(error);
    } finally {
      this.state.siteSaving = false;
      this.render();
    }
  }

  async updatePerimeter(form) {
    if (!this.state.site) return;
    const perimeter = formValue(new FormData(form), "perimeter");
    this.state.perimeterSaving = true;
    this.state.perimeterMessage = "";
    this.state.perimeterError = "";
    this.render();
    try {
      const result = await adminApi.updateSitePerimeter(
        this.state.site.siteId,
        perimeter,
        String(this.state.site.updatedAt || ""),
      );
      this.state.site = { ...this.state.site, ...result };
      this.state.perimeterMessage = "Perimeter saved.";
    } catch (error) {
      this.state.perimeterError =
        error instanceof Error && error.message === "perimeter_update_conflict"
          ? "This Site changed after you opened it. Reload the latest version before saving."
          : "The perimeter could not be saved. Check the text and try again.";
    } finally {
      this.state.perimeterSaving = false;
      this.render();
    }
  }

  /**
   * Open a site with its contacts and devices.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async openSite(siteId, updateUrl = true) {
    if (updateUrl) return navigate(`/sites/${encodeURIComponent(siteId)}`);
    const [site, contacts, devices, terms] = await Promise.all([
      adminApi.getSite(siteId),
      adminApi.listMasterContacts(siteId),
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
    this.state.contacts = contacts.contacts || [];
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

  async assignSiteUser(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    await adminApi.assignSiteUser(
      this.state.site.siteId,
      formValue(data, "user-id"),
      data.get("primary") === "on",
    );
    await this.openSite(this.state.site.siteId, false);
  }

  async setPrimarySiteUser(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    await adminApi.assignSiteUser(
      this.state.site.siteId,
      formValue(data, "primary-user-id"),
      true,
    );
    await this.openSite(this.state.site.siteId, false);
  }

  async unassignSiteUser(userId) {
    if (!this.state.site) return;
    await adminApi.unassignSiteUser(this.state.site.siteId, userId);
    await this.openSite(this.state.site.siteId, false);
  }

  async createSiteTerms(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    await adminApi.createSiteTerms(this.state.site.siteId, {
      tier: Number(data.get("terms-tier")),
      requiredChecksPerDay: Number(data.get("terms-checks-per-day")),
      effectiveStart: formValue(data, "terms-start"),
      expiresOnExclusive: formValue(data, "terms-expiry"),
    });
    await this.openSite(this.state.site.siteId, false);
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
      window.history.replaceState(
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
    } finally {
      this.state.importBusy = false;
      this.render();
    }
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
    this.state.site = null;
    if (this.state.provider) {
      await this.openProvider(this.state.provider.providerId);
    }
  }

  /**
   * Add a master contact to the currently open site.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async addMasterContact(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    await adminApi.addMasterContact(
      this.state.site.siteId,
      String(data.get("contact-email") || ""),
      String(data.get("contact-name") || ""),
    );
    form.reset();
    await this.openSite(this.state.site.siteId);
  }

  /**
   * Remove a master contact from the currently open site.
   * @param {string} emailHash
   * @returns {Promise<void>}
   */
  async removeMasterContact(emailHash) {
    if (!this.state.site) return;
    await adminApi.removeMasterContact(this.state.site.siteId, emailHash);
    await this.openSite(this.state.site.siteId);
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
      accessLevel === "manager" ? "admin" : "general",
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
    await adminApi.revokeDevice(this.state.site.siteId, deviceId);
    await this.openSite(this.state.site.siteId);
  }

  /**
   * Bind event handlers to the currently rendered DOM.
   * @returns {void}
   */
  bind() {
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
      this.state.provider = null;
      this.state.site = null;
      signOutAdmin();
    });
    this.querySelector("#provider-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createProvider(asForm(e.currentTarget));
    });
    this.querySelector("#program-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createProgram(asForm(e.currentTarget)).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector("#program-user-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.createProgramUser(asForm(e.currentTarget)).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
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
        navigate(link.getAttribute("href") || "/sites");
      });
    });
    this.querySelector("#site-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createSite(asForm(e.currentTarget)).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector("#site-details-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.updateSite(asForm(e.currentTarget)).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelector("#site-user-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.assignSiteUser(asForm(e.currentTarget)).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
    });
    this.querySelector("#site-primary-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.setPrimarySiteUser(asForm(e.currentTarget)).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
      },
    );
    this.querySelector("#site-terms-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createSiteTerms(asForm(e.currentTarget)).catch((err) => {
        this.state.error = err.message;
        this.render();
      });
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
    this.querySelector("#apply-site-import")?.addEventListener("click", () => {
      this.applySiteImport().catch((err) => {
        this.state.importBusy = false;
        this.state.error = err.message;
        this.render();
      });
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
    this.querySelector("#contact-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.addMasterContact(asForm(e.currentTarget));
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
      button.addEventListener("click", () =>
        this.deactivateProvider(dataAttr(button, "data-deactivate-provider")),
      );
    });
    this.querySelectorAll("[data-site]").forEach((button) => {
      button.addEventListener("click", () =>
        this.openSite(dataAttr(button, "data-site")),
      );
    });
    this.querySelectorAll("[data-deactivate-site]").forEach((button) => {
      button.addEventListener("click", () =>
        this.deactivateSite(dataAttr(button, "data-deactivate-site")),
      );
    });
    this.querySelectorAll("[data-remove-contact]").forEach((button) => {
      button.addEventListener("click", () =>
        this.removeMasterContact(dataAttr(button, "data-remove-contact")),
      );
    });
    this.querySelectorAll("[data-issue-contact-code]").forEach((button) => {
      button.addEventListener("click", () =>
        this.issueSetupCodeForEmail(
          dataAttr(button, "data-issue-contact-code"),
        ),
      );
    });
    this.querySelectorAll("[data-revoke-device]").forEach((button) => {
      button.addEventListener("click", () =>
        this.revokeDevice(dataAttr(button, "data-revoke-device")),
      );
    });
    this.querySelectorAll("[data-unassign-site-user]").forEach((button) => {
      button.addEventListener("click", () => {
        this.unassignSiteUser(
          dataAttr(button, "data-unassign-site-user"),
        ).catch((err) => {
          this.state.error = err.message;
          this.render();
        });
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
    const route = currentRoute();
    const activeSiteSection =
      new URLSearchParams(window.location.search).get("section") || "details";
    this.innerHTML = `
      <main class="admin" id="main-content">
        <header class="admin__header">
          <div class="site-title">
            <a class="brand" href="/sites" data-route>Good Neighbor Admin</a>
            ${
              this.state.hasToken
                ? '<nav class="admin__nav"><a href="/analytics.html">Analytics</a></nav>'
                : ""
            }
          </div>
          ${
            this.state.hasToken
              ? '<button class="btn-secondary" id="clear-token" type="button">Sign out</button>'
              : ""
          }
        </header>
        ${
          this.state.authConfig.localDebugAdmin
            ? '<p class="muted">Local debug admin mode is active.</p>'
            : ""
        }
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
        ${this.state.hasToken && !provider && !program && !site ? (route.name === "site-import" ? siteImportView(this.state) : directoryView(this.state, route)) : ""}
        ${
          provider
            ? `
              <section class="panel">
                <div class="panel__head">
                  <h1 tabindex="-1">${escapeHtml(provider.name)}</h1>
                  <button class="btn-danger" type="button" data-deactivate-provider="${escapeHtml(provider.providerId)}">
                    Deactivate provider
                  </button>
                </div>
                <form id="site-form" class="inline-form">
                  <label>
                    <span>Site name</span>
                    <input name="site-name" required />
                  </label>
                  <label>
                    <span>Site address</span>
                    <input name="site-address" autocomplete="street-address" required />
                  </label>
                  <label>
                    <span>Lead program</span>
                    <select name="lead-program-id" required>
                      <option value="">Choose a program</option>
                      ${this.state.programs
                        .filter(
                          (item) => item.providerId === provider.providerId,
                        )
                        .map(
                          (item) =>
                            `<option value="${escapeHtml(item.programId)}">${escapeHtml(item.name)}</option>`,
                        )
                        .join("")}
                    </select>
                  </label>
                  <button class="btn-primary" type="submit">Add site</button>
                </form>
                <div class="list">
                  ${(provider.sites || [])
                    .map(
                      (s) => `
                        <div class="row">
                          <a href="/sites/${encodeURIComponent(s.siteId)}" data-route>${escapeHtml(s.siteName)}</a>
                          <button class="btn-danger" type="button" data-deactivate-site="${escapeHtml(s.siteId)}">
                            Deactivate
                          </button>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              </section>
            `
            : ""
        }
        ${program ? programView(program) : ""}
        ${
          site
            ? `
              <section class="panel">
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
                ${siteSectionView(this.state, activeSiteSection)}
              </section>
            `
            : ""
        }
      </main>
    `;
    this.bind();
  }
}

customElements.define("admin-app", AdminApp);

/** @param {string} siteId @param {string} current */
function siteSectionNav(siteId, current) {
  const sections = [
    ["details", "Details"],
    ["staff", "Staff & oversight"],
    ["terms", "Compliance terms"],
    ["letters", "Letters"],
    ["perimeter", "Perimeter"],
    ["access", "App access"],
  ];
  return `<nav class="entity-tabs" aria-label="Site sections">${sections
    .map(
      ([value, label]) =>
        `<a href="/sites/${encodeURIComponent(siteId)}?section=${value}" data-route ${value === current ? 'aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
}

/** @param {AdminState} state @param {string} section */
function siteSectionView(state, section) {
  const site = /** @type {AdminSite} */ (state.site);
  if (section === "staff") return siteStaffView(state);
  if (section === "terms") return siteTermsView(state);
  if (section === "letters") {
    return `<section aria-labelledby="letters-title"><h2 id="letters-title">Letters</h2><p class="muted">Letter state: ${escapeHtml(site.letterState || "No generated letter")}. Letter generation and delivery controls are added after the terms job processor.</p></section>`;
  }
  if (section === "perimeter") {
    return sitePerimeterView(state);
  }
  if (section === "access") return siteAccessView(state);
  return `${siteEditor(site, state.siteSaving, state.siteSaveError)}
    ${state.siteSaveMessage ? `<p id="site-save-status" class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    ${site.geocodedAddress ? `<p class="muted">Mapped to ${escapeHtml(site.geocodedAddress)}</p>` : ""}`;
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
      <p class="muted">Describe the area staff should inspect using streets, block sides, landmarks, or other plain-language directions. This is guidance, not a geofence.</p>
    </div>
    <form id="site-perimeter-form" class="site-details-form">
      <label>
        <span>Perimeter description</span>
        <textarea name="perimeter" rows="8" maxlength="4000" aria-describedby="perimeter-help">${escapeHtml(site.perimeter || "")}</textarea>
      </label>
      <p id="perimeter-help" class="muted">Up to 4,000 characters. Saving a blank description clears the current perimeter.</p>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.perimeterSaving ? "disabled" : ""}>${state.perimeterSaving ? "Saving…" : "Save perimeter"}</button>
        <button class="btn-secondary" type="reset" ${state.perimeterSaving ? "disabled" : ""}>Cancel edits</button>
      </div>
    </form>
    ${site.perimeterUpdatedAt ? `<p class="muted">Last updated ${escapeHtml(formatTimestamp(site.perimeterUpdatedAt))}${updatedBy}.</p>` : '<p class="muted">No perimeter description has been saved.</p>'}
    ${state.perimeterError ? `<div class="error site-details-form__message" role="alert"><p>${escapeHtml(state.perimeterError)}</p>${conflict ? '<button class="btn-secondary" id="reload-site-perimeter" type="button">Reload latest Site</button>' : ""}</div>` : ""}
    ${state.perimeterMessage ? `<p class="success" role="status">${escapeHtml(state.perimeterMessage)}</p>` : ""}
  </section>`;
}

/** @param {AdminState} state */
function siteStaffView(state) {
  const site = /** @type {AdminSite} */ (state.site);
  const assignedIds = new Set(state.assignedUsers.map((user) => user.userId));
  const available = state.availableSiteUsers.filter(
    (user) => !assignedIds.has(user.userId),
  );
  return `<section class="subsection" aria-labelledby="staff-title">
    <div><h2 id="staff-title">Staff and oversight</h2><p class="muted">These are contact records from the lead Program; they do not authenticate.</p></div>
    <h3>Assigned contacts</h3>
    ${siteAssignedUserList(state.assignedUsers, site.primaryContactUserId)}
    <form id="site-primary-form" class="inline-form">
      <label><span>Primary Site contact</span><select name="primary-user-id" required>
        <option value="">Choose an assigned contact</option>
        ${state.assignedUsers.map((user) => `<option value="${escapeHtml(user.userId)}" ${user.userId === site.primaryContactUserId ? "selected" : ""}>${escapeHtml(`${user.firstName} ${user.lastName}`)}</option>`).join("")}
      </select></label>
      <button class="btn-secondary" type="submit" ${state.assignedUsers.length ? "" : "disabled"}>Set primary contact</button>
    </form>
    <form id="site-user-form" class="inline-form">
      <label><span>Program contact</span><select name="user-id" required>
        <option value="">Choose a contact</option>
        ${available.map((user) => `<option value="${escapeHtml(user.userId)}">${escapeHtml(`${user.firstName} ${user.lastName}`)}</option>`).join("")}
      </select></label>
      <label class="checkbox-label"><input name="primary" type="checkbox" /> Make primary Site contact</label>
      <button class="btn-primary" type="submit" ${available.length ? "" : "disabled"}>Assign contact</button>
    </form>
    ${available.length ? "" : '<p class="muted">All active Program contacts are already assigned.</p>'}
  </section>`;
}

/** @param {any[]} users @param {string} primaryContactUserId */
function siteAssignedUserList(users, primaryContactUserId) {
  if (!users.length)
    return '<p class="muted">No Program contacts are assigned.</p>';
  return `<ul class="contact-list">${users
    .map(
      (user) =>
        `<li><div><strong>${escapeHtml(`${user.firstName} ${user.lastName}`)}</strong><span><a href="mailto:${escapeHtml(user.email)}">${escapeHtml(user.email)}</a></span></div><div class="contact-list__actions"><span class="status-badge">${user.userId === primaryContactUserId ? "Primary contact" : "Assigned"}</span><button class="btn-danger" type="button" data-unassign-site-user="${escapeHtml(user.userId)}" ${user.userId === primaryContactUserId ? "disabled" : ""}>Unassign</button></div></li>`,
    )
    .join("")}</ul>`;
}

/** @param {AdminState} state */
function siteTermsView(state) {
  return `<section class="subsection" aria-labelledby="terms-title">
    <div><h2 id="terms-title">Compliance terms</h2><p class="muted">Dates are inclusive at the start and exclusive at expiry. Saving schedules a new draft letter.</p></div>
    <form id="site-terms-form" class="site-details-form">
      <fieldset><legend>Add terms change</legend><div class="form-grid form-grid--two">
        <label><span>GNP tier</span><select name="terms-tier" required>${[0, 1, 2, 3, 4].map((tier) => `<option value="${tier}">${tier === 0 ? "Tier 0 — No enhanced monitoring" : `Tier ${tier}`}</option>`).join("")}</select></label>
        ${formInput("terms-checks-per-day", "Checks required per day", "", { required: true, type: "number", min: 0, max: 100, step: 1 })}
        ${formInput("terms-start", "Start date", firstDayOfNextMonth(), { required: true, type: "date" })}
        ${formInput("terms-expiry", "Expiry date (leave blank for no expiry)", "", { type: "date" })}
      </div></fieldset>
      <button class="btn-primary" type="submit">Save terms change</button>
    </form>
    <h3>Terms history</h3>
    ${termsHistory(state.siteTerms)}
  </section>`;
}

/** @param {any[]} terms */
function termsHistory(terms) {
  if (!terms.length)
    return '<p class="muted">No effective-dated terms have been added.</p>';
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
  return `<section class="subsection" aria-labelledby="access-title">
    <div><h2 id="access-title">App access</h2><p class="muted">Manage transitional setup codes and registered devices.</p></div>
    <form id="contact-form" class="inline-form">
      ${formInput("contact-name", "Contact name", "")}
      ${formInput("contact-email", "Work email", "", { required: true, type: "email" })}
      <button class="btn-primary" type="submit">Add master contact</button>
    </form>
    <div class="list">${state.contacts.map((contact) => `<div class="row"><p>${escapeHtml(contact.name || contact.email)} ${escapeHtml(contact.email)}</p><button class="btn-secondary" type="button" data-issue-contact-code="${escapeHtml(contact.email)}">Generate code</button><button class="btn-danger" type="button" data-remove-contact="${escapeHtml(contact.emailHash)}">Remove</button></div>`).join("")}</div>
    <form id="setup-code-form" class="inline-form">
      ${formInput("setup-email", "Email setup code to", "", { required: true, type: "email" })}
      <label><span>Access</span><select name="setup-access"><option value="general">General access</option><option value="manager">Site manager access</option></select></label>
      <button class="btn-primary" type="submit">Issue setup code</button>
    </form>
    ${state.issuedCode ? `<p class="success">Code ${escapeHtml(state.issuedCode.code)} for ${escapeHtml(state.issuedCode.issuedTo)} (${escapeHtml(state.issuedCode.accessLevel || "general")} access) expires ${escapeHtml(state.issuedCode.expiresAt)}</p>` : ""}
    <h3>Devices</h3><div class="list">${state.devices.map((device) => `<div class="row"><p>${escapeHtml(device.label || device.deviceId)} ${escapeHtml(device.status || "active")}</p><button class="btn-danger" type="button" data-revoke-device="${escapeHtml(device.deviceId)}">Revoke</button></div>`).join("")}</div>
  </section>`;
}

/**
 * Render the top-level entity directory without fetching every provider record.
 * Sites are intentionally discovered through their provider until a paginated,
 * server-side site directory endpoint is available.
 * @param {AdminState} state
 * @param {{ name: string, id: string }} route
 */
function directoryView(state, route) {
  const section = route.name.startsWith("program")
    ? "programs"
    : route.name.startsWith("provider")
      ? "providers"
      : "sites";
  return `<section class="directory" aria-labelledby="directory-title">
    <div class="page-head">
      <div>
        <h1 id="directory-title" tabindex="-1">Site admin</h1>
        <p class="muted">Manage providers, programs, sites, enrollment, and devices.</p>
      </div>
    </div>
    <nav class="entity-tabs" aria-label="Site administration sections">
      ${directoryTab("sites", "Sites", section)}
      ${directoryTab("programs", "Programs", section)}
      ${directoryTab("providers", "Providers", section)}
    </nav>
    ${section === "sites" ? siteDirectory(state.providers) : ""}
    ${section === "programs" ? programDirectory(state) : ""}
    ${section === "providers" ? providerDirectory(state.providers) : ""}
  </section>`;
}

/** @param {string} kind @param {string} label @param {string} current */
function directoryTab(kind, label, current) {
  return `<a href="/${kind}" data-route ${kind === current ? 'aria-current="page"' : ""}>${label}</a>`;
}

/** @param {AdminProvider[]} providers */
function siteDirectory(providers) {
  return `<section class="panel" aria-labelledby="sites-title">
    <div class="panel__head">
      <div>
        <h2 id="sites-title">Sites</h2>
        <p class="muted">Choose a provider to view and manage its sites.</p>
      </div>
      <a class="btn-link" href="/sites/import" data-route>Import CSV</a>
    </div>
    ${entityList(
      providers,
      (provider) => `/providers/${encodeURIComponent(provider.providerId)}`,
      (provider) => provider.name,
      () => "Provider",
      "No providers have been added.",
    )}
  </section>`;
}

/** @param {AdminState} state */
function siteImportView(state) {
  const preview = state.importPreview;
  const counts = preview?.counts || {};
  const applicable = Number(counts.create || 0) + Number(counts.reuse || 0);
  const skipped = Number(counts.conflict || 0) + Number(counts.invalid || 0);
  const hasConflictReport =
    skipped > 0 ||
    Number(state.importResult?.outcomes?.skipped_conflict || 0) > 0 ||
    Number(state.importResult?.outcomes?.failed || 0) > 0;
  return `<section class="directory" aria-labelledby="import-title">
    <div class="page-head"><div><p class="muted"><a href="/sites" data-route>Sites</a></p><h1 id="import-title" tabindex="-1">Import sites</h1><p class="muted">Preview first. Applying uses one atomic transaction per valid logical row; conflicts and invalid rows are skipped.</p></div></div>
    <section class="panel" aria-labelledby="upload-title">
      <h2 id="upload-title">1. Upload</h2>
      <p>Upload a UTF-8 CSV no larger than 1 MB or 500 data rows with these exact columns:</p>
      <p class="column-list"><code>Provider</code>, <code>Program</code>, <code>Site name</code>, <code>Site address</code>, <code>Contact first name</code>, <code>Contact last name</code>, <code>Contact phone</code>, <code>Contact email</code>.</p>
      <form id="site-import-form" class="inline-form">
        <label><span>Site import CSV</span><input name="site-import-file" type="file" accept="text/csv,.csv" required /></label>
        <button class="btn-primary" type="submit" ${state.importBusy ? "disabled" : ""}>${state.importBusy ? "Working…" : "Preview import"}</button>
      </form>
    </section>
    ${preview ? `<section class="panel" aria-labelledby="review-title"><h2 id="review-title">2. Review</h2><dl class="import-summary"><div><dt>Create</dt><dd>${Number(counts.create || 0)}</dd></div><div><dt>Reuse exact matches</dt><dd>${Number(counts.reuse || 0)}</dd></div><div><dt>Conflicts</dt><dd>${Number(counts.conflict || 0)}</dd></div><div><dt>Invalid</dt><dd>${Number(counts.invalid || 0)}</dd></div></dl>${importRowsTable(preview.rows || [])}<div class="confirmation"><p><strong>Apply ${applicable} valid rows; skip ${skipped} conflicting or invalid rows.</strong></p><button class="btn-primary" id="apply-site-import" type="button" ${state.importBusy || state.importResult?.status === "complete" ? "disabled" : ""}>${state.importResult?.status === "applying" ? "Continue apply" : "Confirm and apply"}</button>${hasConflictReport ? '<button class="btn-secondary" id="download-import-conflicts" type="button">Download conflict CSV</button>' : ""}</div></section>` : ""}
    ${state.importResult ? `<section class="panel" aria-labelledby="result-title"><h2 id="result-title">3. Result</h2><p class="${state.importResult.status === "complete" ? "success" : "muted"}" role="status">${state.importResult.status === "complete" ? "Import complete." : "Applying the next group of rows…"}</p>${importOutcomeSummary(state.importResult.outcomes || {})}${importResultLinks(preview?.rows || [])}</section>` : ""}
  </section>`;
}

/** @param {any[]} rows */
function importRowsTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>Row</th><th>Site</th><th>Provider</th><th>Program</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.rowNumber)}</td><td>${escapeHtml(row.source?.["Site name"] || "")}</td><td>${escapeHtml(row.source?.Provider || "")}</td><td>${escapeHtml(row.source?.Program || "")}</td><td><span class="status-badge">${escapeHtml(row.classification)}</span></td><td>${escapeHtml(row.reasonCode || "—")}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
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

/** @param {AdminState} state */
function programDirectory(state) {
  return `<section class="panel" aria-labelledby="programs-title">
    <div>
      <h2 id="programs-title">Programs</h2>
      <p class="muted">Programs group sites under a provider.</p>
    </div>
    <form id="program-form" class="site-details-form">
      <fieldset>
        <legend>Add program</legend>
        <div class="form-grid form-grid--two">
          ${formInput("program-name", "Program name", "", { required: true, autocomplete: "organization" })}
          <label><span>Provider</span><select name="program-provider" required>
            <option value="">Choose a provider</option>
            ${state.providers.map((provider) => `<option value="${escapeHtml(provider.providerId)}">${escapeHtml(provider.name)}</option>`).join("")}
          </select></label>
          ${formInput("contact-first-name", "Contact first name", "", { autocomplete: "given-name" })}
          ${formInput("contact-last-name", "Contact last name", "", { autocomplete: "family-name" })}
          ${formInput("contact-phone", "Contact phone", "", { type: "tel", autocomplete: "tel" })}
          ${formInput("contact-email", "Contact email", "", { type: "email", autocomplete: "email" })}
        </div>
      </fieldset>
      <button class="btn-primary" type="submit">Add program</button>
    </form>
    ${entityList(
      state.programs,
      (program) => `/programs/${encodeURIComponent(program.programId)}`,
      (program) => program.name,
      (program) => program.providerName || "Provider not recorded",
      "No programs have been added.",
    )}
  </section>`;
}

/** @param {AdminProvider[]} providers */
function providerDirectory(providers) {
  return `<section class="panel" aria-labelledby="providers-title">
    <div>
      <h2 id="providers-title">Providers</h2>
      <p class="muted">Providers contain programs and sites.</p>
    </div>
    <form id="provider-form" class="inline-form">
      ${formInput("provider-name", "Provider name", "", { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit">Add provider</button>
    </form>
    ${entityList(
      providers,
      (provider) => `/providers/${encodeURIComponent(provider.providerId)}`,
      (provider) => provider.name,
      () => "Provider",
      "No providers have been added.",
    )}
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

/** @param {any} program */
function programView(program) {
  const contact = program.contact || {};
  const contactName = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(" ");
  return `<section class="panel">
    <div class="panel__head">
      <div>
        <h1 tabindex="-1">${escapeHtml(program.name)}</h1>
        <p class="muted"><a href="/providers/${encodeURIComponent(program.providerId)}" data-route>${escapeHtml(program.providerName || "Provider")}</a></p>
      </div>
      ${program.needsReview ? '<span class="status-badge">Needs review</span>' : '<span class="status-badge">Active</span>'}
    </div>
    <dl class="detail-list">
      <div><dt>Primary contact</dt><dd>${escapeHtml(contactName || "Not assigned")}</dd></div>
      <div><dt>Email</dt><dd>${contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : "Not provided"}</dd></div>
      <div><dt>Phone</dt><dd>${escapeHtml(contact.phone || "Not provided")}</dd></div>
    </dl>
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
    <section class="subsection" aria-labelledby="program-users-title">
      <div>
        <h2 id="program-users-title">Program contacts</h2>
        <p class="muted">Contact records do not receive accounts or sign-in access.</p>
      </div>
      <form id="program-user-form" class="site-details-form">
        <fieldset>
          <legend>Add program contact</legend>
          <div class="form-grid form-grid--two">
            ${formInput("user-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
            ${formInput("user-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
            ${formInput("user-phone", "Phone", "", { required: true, type: "tel", autocomplete: "tel" })}
            ${formInput("user-email", "Email", "", { required: true, type: "email", autocomplete: "email" })}
          </div>
        </fieldset>
        <button class="btn-primary" type="submit">Add contact</button>
      </form>
      ${programUserList((program.users || []).filter((user) => user.status !== "inactive"))}
    </section>
  </section>`;
}

/** @param {any[]} users @param {string} [primaryContactUserId] */
function programUserList(users, primaryContactUserId = "") {
  if (!users.length)
    return '<p class="muted">No program contacts have been added.</p>';
  return `<ul class="contact-list">${users
    .map(
      (user) => `<li>
        <div><strong>${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" "))}</strong>
        <span><a href="mailto:${escapeHtml(user.email)}">${escapeHtml(user.email)}</a></span></div>
        <div class="contact-list__meta"><span>${escapeHtml(user.phone)}</span><span>${primaryContactUserId ? (user.userId === primaryContactUserId ? "Primary contact" : "Assigned") : `${Number(user.siteAssignmentCount || 0)} site ${Number(user.siteAssignmentCount || 0) === 1 ? "assignment" : "assignments"}`}</span></div>
      </li>`,
    )
    .join("")}</ul>`;
}

/**
 * @param {AdminSite} site
 * @param {boolean} saving
 * @param {string} saveError
 */
function siteEditor(site, saving, saveError) {
  const address = site.addressParts || {};
  const contact = site.contactPerson || {};
  const oversight = site.oversight || {};
  const compliance = site.compliance || {};
  const manager = splitPersonName(oversight.cityProgramManager);
  const department = normalizeDepartment(oversight.managingCityDepartment);
  const currentLetter = site.complianceLetters?.current;
  const hasAddress = Boolean(site.addressParts);
  const hasContact = Boolean(site.contactPerson);
  const hasOversight = Boolean(site.oversight);
  const hasCompliance = Boolean(site.compliance);
  return `<form id="site-details-form" class="site-details-form">
    <fieldset>
      <legend>Site details</legend>
      <div class="form-grid form-grid--two">
        ${formInput("site-name", "Site name", site.name, { required: true, autocomplete: "organization" })}
        ${formInput("street-number", "Street number", address.streetNumber, { required: hasAddress, autocomplete: "address-line1" })}
        ${formInput("street-address", "Street address", address.streetAddress, { required: hasAddress, autocomplete: "address-line1" })}
        ${formInput("address-second-line", "Second line", address.secondLine, { autocomplete: "address-line2" })}
        ${formInput("city", "City", address.city, { required: hasAddress, autocomplete: "address-level2" })}
        ${formInput("state", "State", address.state, { required: hasAddress, autocomplete: "address-level1", maxlength: 2 })}
        ${formInput("zip", "ZIP", address.zip, { required: hasAddress, autocomplete: "postal-code", pattern: "[0-9]{5}(-[0-9]{4})?" })}
      </div>
      ${formatSiteCoordinates(site.location)}
    </fieldset>
    <fieldset>
      <legend>Contact person</legend>
      <div class="form-grid form-grid--two">
        ${formInput("contact-first-name", "First name", contact.firstName, { required: hasContact, autocomplete: "given-name" })}
        ${formInput("contact-last-name", "Last name", contact.lastName, { required: hasContact, autocomplete: "family-name" })}
        ${formInput("contact-email", "Email", contact.email, { required: hasContact, type: "email", autocomplete: "email" })}
        ${formInput("contact-phone", "Phone", contact.phone, { required: hasContact, type: "tel", autocomplete: "tel", pattern: "[0-9()+ .-]{10,20}" })}
      </div>
    </fieldset>
    <fieldset>
      <legend>Oversight</legend>
      <div class="form-grid form-grid--two">
        <label>
          <span>Managing City department</span>
          <select name="managing-city-department" ${hasOversight ? "required" : ""}>
            <option value="" ${department ? "" : "selected"}>Choose department</option>
            <option value="DPH" ${department === "DPH" ? "selected" : ""}>DPH</option>
            <option value="HSH" ${department === "HSH" ? "selected" : ""}>HSH</option>
          </select>
        </label>
        ${formInput("managing-system-of-care", "Managing system of care", oversight.managingSystemOfCare)}
        ${formInput("program-manager-first-name", "City program manager first name", manager.firstName, { autocomplete: "given-name" })}
        ${formInput("program-manager-last-name", "City program manager last name", manager.lastName, { autocomplete: "family-name" })}
      </div>
    </fieldset>
    <fieldset>
      <legend>Compliance</legend>
      <div class="form-grid form-grid--two">
        <label>
          <span>Current tier</span>
          <select name="current-tier" ${hasCompliance ? "required" : ""}>
            <option value="" ${compliance.currentTier === undefined || compliance.currentTier === "" ? "selected" : ""}>Choose tier</option>
            ${[0, 1, 2, 3, 4]
              .map(
                (tier) =>
                  `<option value="${tier}" ${Number(compliance.currentTier) === tier ? "selected" : ""}>${tier === 0 ? "Tier 0 — No enhanced monitoring" : `Tier ${tier}`}</option>`,
              )
              .join("")}
          </select>
        </label>
        ${formInput("tier-period-start", "Tier period start", compliance.periodStart, { required: hasCompliance, type: "date" })}
        ${formInput("tier-period-end", "Tier period end (leave blank for present)", compliance.periodEnd, { type: "date" })}
        ${formInput("required-checks-per-day", "Required checks per day", compliance.requiredChecksPerDay ?? "", { required: hasCompliance, type: "number", min: 0, max: 100, step: 1 })}
      </div>
    </fieldset>
    <fieldset>
      <legend>Compliance letter</legend>
      ${currentLetter ? `<p class="muted current-letter">Current: ${escapeHtml(currentLetter.fileName || "compliance letter")}</p>` : '<p class="muted current-letter">No current compliance letter.</p>'}
      <label>
        <span>Upload a new PDF to supersede the current letter</span>
        <input name="compliance-letter" type="file" accept="application/pdf,.pdf" />
      </label>
      <p class="muted field-help">PDF only, up to 10 MB. The previous current letter will move to past letters.</p>
    </fieldset>
    ${saveError ? `<p id="site-save-error" class="error site-details-form__message" role="alert">${escapeHtml(saveError)}</p>` : ""}
    <button class="btn-primary" type="submit" ${saving ? "disabled" : ""}>
      ${saving ? "Saving..." : "Save site"}
    </button>
  </form>`;
}

/**
 * @param {string} name
 * @param {string} label
 * @param {unknown} value
 * @param {{ required?: boolean, type?: string, autocomplete?: string, pattern?: string, maxlength?: number, min?: number, max?: number, step?: number }} [options]
 */
function formInput(name, label, value, options = {}) {
  const attributes = [
    options.required ? "required" : "",
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
  return `<label>
    <span>${escapeHtml(label)}</span>
    <input name="${escapeHtml(name)}" type="${escapeHtml(options.type || "text")}" value="${escapeHtml(value ?? "")}" ${attributes} />
  </label>`;
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
  const department = String(value || "").toUpperCase();
  if (!department) return "";
  return department === "HSH" || department.includes("HOMELESS")
    ? "HSH"
    : "DPH";
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
 * @returns {string}
 */
function formatSiteCoordinates(location) {
  if (!hasSiteCoordinates(location)) return "";
  return `<p class="muted site-details-form__coordinates">Lat ${escapeHtml(location.latitude)}, Long ${escapeHtml(location.longitude)}</p>`;
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
    return "Choose DPH or HSH for the managing City department.";
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
