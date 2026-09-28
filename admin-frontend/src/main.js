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

/**
 * @typedef {ReturnType<typeof getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, siteName?: string, name?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number>, perimeter?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ email: string, emailHash: string, name?: string, status?: string }} AdminContact
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {object} AdminState
 * @property {AdminProvider[]} providers
 * @property {AdminProvider | null} provider
 * @property {AdminSite | null} site
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
 */

class AdminApp extends HTMLElement {
  constructor() {
    super();
    /** @type {AdminState} */
    this.state = {
      providers: [],
      provider: null,
      site: null,
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
    };
  }

  /**
   * Initialize admin auth state and load provider data when signed in.
   * @returns {Promise<void>}
   */
  async connectedCallback() {
    this.state = {
      providers: [],
      provider: null,
      site: null,
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
    if (this.state.hasToken) this.loadProviders();
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
  async openProvider(providerId) {
    const data = await adminApi.getProvider(providerId);
    this.state.provider = data.provider;
    this.state.site = null;
    this.state.contacts = [];
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.provider.sites = data.sites || [];
    this.render();
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
    if (!name || !address || !this.state.provider) return;
    await adminApi.createSite(this.state.provider.providerId, {
      name: String(name),
      address: String(address),
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
    const values = {
      name,
      addressParts,
      contactPerson: {
        firstName: formValue(data, "contact-first-name"),
        lastName: formValue(data, "contact-last-name"),
        email: formValue(data, "contact-email"),
        phone: formValue(data, "contact-phone"),
      },
      oversight: {
        managingCityDepartment: formValue(data, "managing-city-department"),
        managingSystemOfCare: formValue(data, "managing-system-of-care"),
        cityProgramManagerFirstName: formValue(
          data,
          "program-manager-first-name",
        ),
        cityProgramManagerLastName: formValue(
          data,
          "program-manager-last-name",
        ),
      },
      compliance: {
        currentTier: Number(data.get("current-tier")),
        periodStart: formValue(data, "tier-period-start"),
        periodEnd: formValue(data, "tier-period-end"),
        requiredChecksPerDay: Number(data.get("required-checks-per-day")),
      },
      perimeter: formValue(data, "perimeter"),
    };
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
      if (!hasSiteCoordinates(location)) {
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

  /**
   * Open a site with its contacts and devices.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async openSite(siteId) {
    const [site, contacts, devices] = await Promise.all([
      adminApi.getSite(siteId),
      adminApi.listMasterContacts(siteId),
      adminApi.listDevices(siteId),
    ]);
    this.state.site = site.items?.find((item) => item.sk === "#META") || null;
    this.state.contacts = contacts.contacts || [];
    this.state.devices = devices.devices || [];
    this.state.issuedCode = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.render();
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
      accessLevel === "admin" ? "admin" : "general",
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
  }

  /**
   * Render the current admin application state.
   * @returns {void}
   */
  render() {
    const provider = this.state.provider;
    const site = this.state.site;
    this.innerHTML = `
      <main class="admin">
        <header class="admin__header">
          <div class="site-title">
            <h1>Good Neighbor Admin</h1>
            ${
              this.state.hasToken
                ? '<nav class="admin__nav"><a href="/analytics.html">Analytics</a></nav>'
                : ""
            }
          </div>
          ${
            this.state.hasToken
              ? '<button id="clear-token" type="button">Sign out</button>'
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
                <button id="sign-in" type="button" ${this.state.authBusy ? "disabled" : ""}>
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
          this.state.hasToken
            ? `<section class="panel">
          <h2>Providers</h2>
          <form id="provider-form" class="inline-form">
            <label>
              <span>Provider name</span>
              <input name="provider-name" required />
            </label>
            <button type="submit">Add provider</button>
          </form>
          <div class="list">
            ${this.state.providers
              .map(
                (p) => `
                  <button type="button" data-provider="${escapeHtml(p.providerId)}">
                    ${escapeHtml(p.name)}
                  </button>
                `,
              )
              .join("")}
          </div>
        </section>`
            : ""
        }
        ${
          provider
            ? `
              <section class="panel">
                <div class="panel__head">
                  <h2>${escapeHtml(provider.name)}</h2>
                  <button type="button" data-deactivate-provider="${escapeHtml(provider.providerId)}">
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
                  <button type="submit">Add site</button>
                </form>
                <div class="list">
                  ${(provider.sites || [])
                    .map(
                      (s) => `
                        <div class="row">
                          <button type="button" data-site="${escapeHtml(s.siteId)}">
                            ${escapeHtml(s.siteName)}
                          </button>
                          <button type="button" data-deactivate-site="${escapeHtml(s.siteId)}">
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
        ${
          site
            ? `
              <section class="panel">
                <div class="panel__head">
                  <div class="site-title">
                    <h2>${escapeHtml(site.name)}</h2>
                    <p class="muted site-title__updated">
                      Last updated ${escapeHtml(formatTimestamp(site.updatedAt))}
                    </p>
                  </div>
                  <button type="button" data-deactivate-site="${escapeHtml(site.siteId)}">
                    Deactivate site
                  </button>
                </div>
                ${siteEditor(site, this.state.siteSaving, this.state.siteSaveError)}
                ${this.state.siteSaveMessage ? `<p id="site-save-status" class="success" role="status">${escapeHtml(this.state.siteSaveMessage)}</p>` : ""}
                ${site.geocodedAddress ? `<p class="muted">Mapped to ${escapeHtml(site.geocodedAddress)}</p>` : ""}
                <form id="contact-form" class="inline-form">
                  <label>
                    <span>Contact name</span>
                    <input name="contact-name" />
                  </label>
                  <label>
                    <span>Work email</span>
                    <input name="contact-email" type="email" required />
                  </label>
                  <button type="submit">Add master contact</button>
                </form>
                <div class="list">
                  ${this.state.contacts
                    .map(
                      (c) => `
                        <div class="row">
                          <p>${escapeHtml(c.name || c.email)} ${escapeHtml(c.email)}</p>
                          <button type="button" data-issue-contact-code="${escapeHtml(c.email)}">
                            Generate code
                          </button>
                          <button type="button" data-remove-contact="${escapeHtml(c.emailHash)}">
                            Remove
                          </button>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
                <form id="setup-code-form" class="inline-form">
                  <label>
                    <span>Email setup code to</span>
                    <input name="setup-email" type="email" required />
                  </label>
                  <label>
                    <span>Access</span>
                    <select name="setup-access">
                      <option value="general">General access</option>
                      <option value="admin">Admin access</option>
                    </select>
                  </label>
                  <button type="submit">Issue setup code</button>
                </form>
                ${
                  this.state.issuedCode
                    ? `<p class="success">Code ${escapeHtml(this.state.issuedCode.code)} for ${escapeHtml(this.state.issuedCode.issuedTo)} (${escapeHtml(this.state.issuedCode.accessLevel || "general")} access) expires ${escapeHtml(this.state.issuedCode.expiresAt)}</p>`
                    : ""
                }
                <h3>Devices</h3>
                <div class="list">
                  ${this.state.devices
                    .map(
                      (d) => `
                        <div class="row">
                          <p>${escapeHtml(d.label || d.deviceId)} ${escapeHtml(d.status || "active")}</p>
                          <button type="button" data-revoke-device="${escapeHtml(d.deviceId)}">
                            Revoke
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
      </main>
    `;
    this.bind();
  }
}

customElements.define("admin-app", AdminApp);

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
  return `<form id="site-details-form" class="site-details-form">
    <fieldset>
      <legend>Site details</legend>
      <div class="form-grid form-grid--two">
        ${formInput("site-name", "Site name", site.name, { required: true, autocomplete: "organization" })}
        ${formInput("street-number", "Street number", address.streetNumber, { required: true, autocomplete: "address-line1" })}
        ${formInput("street-address", "Street address", address.streetAddress, { required: true, autocomplete: "address-line1" })}
        ${formInput("address-second-line", "Second line", address.secondLine, { autocomplete: "address-line2" })}
        ${formInput("city", "City", address.city, { required: true, autocomplete: "address-level2" })}
        ${formInput("state", "State", address.state, { required: true, autocomplete: "address-level1", maxlength: 2 })}
        ${formInput("zip", "ZIP", address.zip, { required: true, autocomplete: "postal-code", pattern: "[0-9]{5}(-[0-9]{4})?" })}
      </div>
      ${formatSiteCoordinates(site.location)}
    </fieldset>
    <fieldset>
      <legend>Contact person</legend>
      <div class="form-grid form-grid--two">
        ${formInput("contact-first-name", "First name", contact.firstName, { required: true, autocomplete: "given-name" })}
        ${formInput("contact-last-name", "Last name", contact.lastName, { required: true, autocomplete: "family-name" })}
        ${formInput("contact-email", "Email", contact.email, { required: true, type: "email", autocomplete: "email" })}
        ${formInput("contact-phone", "Phone", contact.phone, { required: true, type: "tel", autocomplete: "tel", pattern: "[0-9()+ .-]{10,20}" })}
      </div>
    </fieldset>
    <fieldset>
      <legend>Oversight</legend>
      <div class="form-grid form-grid--two">
        <label>
          <span>Managing City department</span>
          <select name="managing-city-department" required>
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
          <select name="current-tier" required>
            ${[1, 2, 3, 4]
              .map(
                (tier) =>
                  `<option value="${tier}" ${Number(compliance.currentTier) === tier ? "selected" : ""}>Tier ${tier}</option>`,
              )
              .join("")}
          </select>
        </label>
        ${formInput("tier-period-start", "Tier period start", compliance.periodStart, { required: true, type: "date" })}
        ${formInput("tier-period-end", "Tier period end (leave blank for present)", compliance.periodEnd, { type: "date" })}
        ${formInput("required-checks-per-day", "Required checks per day", compliance.requiredChecksPerDay ?? 0, { required: true, type: "number", min: 0, max: 100, step: 1 })}
      </div>
    </fieldset>
    <fieldset>
      <legend>Perimeter</legend>
      <label>
        <span>Perimeter description</span>
        <textarea name="perimeter" rows="5" maxlength="4000">${escapeHtml(site.perimeter || "")}</textarea>
      </label>
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
    <button type="submit" ${saving ? "disabled" : ""}>
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
  return department === "HSH" || department.includes("HOMELESS")
    ? "HSH"
    : "DPH";
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
  return "The site couldn't be saved. Try again.";
}
