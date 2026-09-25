import {
  clearAdminSession,
  completeAdminLoginFromUrl,
  hasAdminSession,
  signOutAdmin,
  startAdminLogin,
} from "./services/admin-auth.js";
import { adminApi } from "./services/admin-api.js";
import { getAdminConfig } from "./config.js";

/**
 * @typedef {ReturnType<typeof getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, siteName?: string, name?: string, address?: string, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ email: string, emailHash: string, name?: string, status?: string }} AdminContact
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {{ columns: string[], rows: unknown[][], truncated: boolean, elapsedMs: number }} AnalyticsResult
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
 * @property {string} analyticsSql
 * @property {AnalyticsResult | null} analyticsResult
 * @property {boolean} analyticsBusy
 * @property {string} analyticsError
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
      analyticsSql: "",
      analyticsResult: null,
      analyticsBusy: false,
      analyticsError: "",
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
      analyticsSql: "",
      analyticsResult: null,
      analyticsBusy: false,
      analyticsError: "",
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
    const name = String(data.get("site-name") || "");
    const address = String(data.get("site-address") || "");
    this.state.siteSaving = true;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.error = "";
    this.render();
    try {
      const result = await adminApi.updateSite(this.state.site.siteId, {
        name,
        address,
      });
      const location = result.site?.location;
      this.state.site = {
        ...this.state.site,
        ...result.site,
        name,
        address,
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
    const email = new FormData(form).get("setup-email");
    await this.issueSetupCodeForEmail(String(email || ""));
    form.reset();
  }

  /**
   * Issue a setup code to a specific email on the currently open site.
   * @param {string} email
   * @returns {Promise<void>}
   */
  async issueSetupCodeForEmail(email) {
    if (!this.state.site || !email.trim()) return;
    const result = await adminApi.issueSetupCode(this.state.site.siteId, email);
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
   * Run the SQL from the analytics panel against the lake.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async runAnalyticsQuery(form) {
    const sql = String(new FormData(form).get("analytics-sql") || "").trim();
    if (!sql) return;
    this.state.analyticsSql = sql;
    this.state.analyticsBusy = true;
    this.state.analyticsError = "";
    this.render();
    try {
      this.state.analyticsResult = await adminApi.analyticsQuery(sql);
    } catch (err) {
      this.state.analyticsError = err.message;
    }
    this.state.analyticsBusy = false;
    this.render();
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
    this.querySelector("#analytics-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.runAnalyticsQuery(asForm(e.currentTarget));
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
          <h1>Good Neighbor Admin</h1>
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
        ${this.state.hasToken ? renderAnalyticsPanel(this.state) : ""}
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
                <form id="site-details-form" class="site-details-form">
                  <label>
                    <span>Site name</span>
                    <input name="site-name" value="${escapeHtml(site.name)}" required />
                  </label>
                  <label>
                    <span>Site address</span>
                    <input name="site-address" autocomplete="street-address" value="${escapeHtml(site.address || "")}" required />
                  </label>
                  ${formatSiteCoordinates(site.location)}
                  ${this.state.siteSaveError ? `<p id="site-save-error" class="error site-details-form__message" role="alert">${escapeHtml(this.state.siteSaveError)}</p>` : ""}
                  <button type="submit" ${this.state.siteSaving ? "disabled" : ""}>
                    ${this.state.siteSaving ? "Saving..." : "Save site"}
                  </button>
                </form>
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
                  <button type="submit">Issue setup code</button>
                </form>
                ${
                  this.state.issuedCode
                    ? `<p class="success">Code ${escapeHtml(this.state.issuedCode.code)} for ${escapeHtml(this.state.issuedCode.issuedTo)} expires ${escapeHtml(this.state.issuedCode.expiresAt)}</p>`
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
 * Render the analytics query panel (signed-in only).
 * @param {AdminState} state
 * @returns {string}
 */
function renderAnalyticsPanel(state) {
  const result = state.analyticsResult;
  return `
    <section class="panel analytics-panel">
      <div class="panel__head">
        <h2>Analytics</h2>
        <p class="muted analytics-panel__hint">
          Read-only SQL over the reporting lake — views: checks, tasks, conditions,
          assessments, artifacts, analyses, sites, providers, devices
        </p>
      </div>
      <form id="analytics-form" class="analytics-form">
        <label>
          <span>SQL</span>
          <textarea
            name="analytics-sql"
            rows="4"
            spellcheck="false"
            placeholder="SELECT siteId, count(*) AS n FROM checks WHERE date >= current_date - 7 GROUP BY 1 ORDER BY 2 DESC"
          >${escapeHtml(state.analyticsSql)}</textarea>
        </label>
        <button type="submit" ${state.analyticsBusy ? "disabled" : ""}>
          ${state.analyticsBusy ? "Running..." : "Run query"}
        </button>
      </form>
      ${
        state.analyticsError
          ? `<p class="error" role="alert">${escapeHtml(state.analyticsError)}</p>`
          : ""
      }
      ${
        result
          ? `
            <p class="muted analytics-panel__meta">
              ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}
              ${result.truncated ? "· <strong>truncated</strong>" : ""}
              · ${result.elapsedMs} ms
            </p>
            ${
              result.rows.length
                ? `<div class="table-wrap"><table>
                    <thead><tr>${result.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr></thead>
                    <tbody>
                      ${result.rows
                        .map(
                          (row) => `<tr>${row
                            .map((v) => `<td>${escapeHtml(String(v ?? ""))}</td>`)
                            .join("")}</tr>`,
                        )
                        .join("")}
                    </tbody>
                  </table></div>`
                : '<p class="muted">No rows returned.</p>'
            }
          `
          : ""
      }
    </section>
  `;
}

/**
 * @param {EventTarget | null} target
 * @returns {HTMLFormElement}
 */
function asForm(target) {
  if (target instanceof HTMLFormElement) return target;
  throw new TypeError("Expected form event target");
}

/**
 * @param {Element} element
 * @param {string} name
 * @returns {string}
 */
function dataAttr(element, name) {
  return element.getAttribute(name) ?? "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function formatTimestamp(value) {
  if (!value) return "not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not available";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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
  return "The site couldn't be saved. Try again.";
}
