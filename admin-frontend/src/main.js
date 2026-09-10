import {
  clearAdminSession,
  completeAdminLoginFromUrl,
  hasAdminSession,
  signOutAdmin,
  startAdminLogin,
} from "./services/admin-auth.js";
import { adminApi } from "./services/admin-api.js";
import { getAdminConfig } from "./config.js";

class AdminApp extends HTMLElement {
  async connectedCallback() {
    this.state = {
      providers: [],
      provider: null,
      site: null,
      contacts: [],
      devices: [],
      issuedCode: null,
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

  async createProvider(form) {
    const name = new FormData(form).get("provider-name");
    if (!name) return;
    await adminApi.createProvider(String(name));
    form.reset();
    await this.loadProviders();
  }

  async openProvider(providerId) {
    const data = await adminApi.getProvider(providerId);
    this.state.provider = data.provider;
    this.state.site = null;
    this.state.contacts = [];
    this.state.provider.sites = data.sites || [];
    this.render();
  }

  async deactivateProvider(providerId) {
    await adminApi.deactivateProvider(providerId);
    this.state.provider = null;
    this.state.site = null;
    await this.loadProviders();
  }

  async createSite(form) {
    const name = new FormData(form).get("site-name");
    if (!name || !this.state.provider) return;
    await adminApi.createSite(this.state.provider.providerId, String(name));
    form.reset();
    await this.openProvider(this.state.provider.providerId);
  }

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
    this.render();
  }

  async deactivateSite(siteId) {
    await adminApi.deactivateSite(siteId);
    this.state.site = null;
    if (this.state.provider) {
      await this.openProvider(this.state.provider.providerId);
    }
  }

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

  async removeMasterContact(emailHash) {
    if (!this.state.site) return;
    await adminApi.removeMasterContact(this.state.site.siteId, emailHash);
    await this.openSite(this.state.site.siteId);
  }

  async issueSetupCode(form) {
    if (!this.state.site) return;
    const email = new FormData(form).get("setup-email");
    const result = await adminApi.issueSetupCode(
      this.state.site.siteId,
      String(email || ""),
    );
    this.state.issuedCode = result.setupCode;
    form.reset();
    this.render();
  }

  async revokeDevice(deviceId) {
    if (!this.state.site) return;
    await adminApi.revokeDevice(this.state.site.siteId, deviceId);
    await this.openSite(this.state.site.siteId);
  }

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
      this.createProvider(e.currentTarget);
    });
    this.querySelector("#site-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.createSite(e.currentTarget);
    });
    this.querySelector("#contact-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.addMasterContact(e.currentTarget);
    });
    this.querySelector("#setup-code-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.issueSetupCode(e.currentTarget);
    });
    this.querySelectorAll("[data-provider]").forEach((button) => {
      button.addEventListener("click", () =>
        this.openProvider(button.getAttribute("data-provider")),
      );
    });
    this.querySelectorAll("[data-deactivate-provider]").forEach((button) => {
      button.addEventListener("click", () =>
        this.deactivateProvider(
          button.getAttribute("data-deactivate-provider"),
        ),
      );
    });
    this.querySelectorAll("[data-site]").forEach((button) => {
      button.addEventListener("click", () =>
        this.openSite(button.getAttribute("data-site")),
      );
    });
    this.querySelectorAll("[data-deactivate-site]").forEach((button) => {
      button.addEventListener("click", () =>
        this.deactivateSite(button.getAttribute("data-deactivate-site")),
      );
    });
    this.querySelectorAll("[data-remove-contact]").forEach((button) => {
      button.addEventListener("click", () =>
        this.removeMasterContact(button.getAttribute("data-remove-contact")),
      );
    });
    this.querySelectorAll("[data-revoke-device]").forEach((button) => {
      button.addEventListener("click", () =>
        this.revokeDevice(button.getAttribute("data-revoke-device")),
      );
    });
  }

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
                  <h2>${escapeHtml(site.name)}</h2>
                  <button type="button" data-deactivate-site="${escapeHtml(site.siteId)}">
                    Deactivate site
                  </button>
                </div>
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
                    ? `<p class="success">Code ${escapeHtml(this.state.issuedCode.code)} expires ${escapeHtml(this.state.issuedCode.expiresAt)}</p>`
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
