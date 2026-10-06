import "./site-admin.css";
import "@awesome.me/webawesome/dist/components/input/input.js";
import { getSite, hasAdminAccess, saveSiteSettings } from "../db.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import {
  backOrNavigate,
  currentRoute,
  navigate,
  setPopstateGuard,
} from "../router.js";
import { getSiteAdmin, updateSiteAdmin } from "../services/api.js";
import {
  cancelStaffEnrollmentGrant,
  createStaffEnrollmentGrant,
  getCurrentStaffEnrollmentGrant,
  listManagerDeviceBindings,
  revokeManagerDeviceBinding,
} from "../services/api.js";
import { announceScreenHeading } from "../screen-focus.js";
import {
  showSiteAdminErrorToast,
  showSiteAdminSuccessToast,
} from "../state/toasts.js";
import {
  formatAdminDate,
  formatDeviceEnrollmentSummary,
  formatAdminPhone,
  validateContact,
  validateSiteDetails,
  valuesChanged,
} from "./site-admin.validation.js";

const EMPTY = "—";

/** @param {unknown} value */
const text = (value) => String(value || "").trim();

/** @param {unknown} value */
function display(value) {
  return escapeHtml(text(value) || EMPTY);
}

class SiteAdminView extends HTMLElement {
  async connectedCallback() {
    const binding = await getSite();
    if (!hasAdminAccess(binding)) {
      navigate("/today");
      return;
    }
    this.innerHTML = loadingView("Site information");
    try {
      const [siteResult, deviceResult] = await Promise.all([
        getSiteAdmin(),
        listManagerDeviceBindings(),
      ]);
      this._site = siteResult.site;
      this._bindings = deviceResult.bindings || [];
      this._render();
      announceScreenHeading(this, ".site-admin-header h1");
    } catch {
      this.innerHTML = errorView("We couldn't load the site information.");
      this._wireBack();
    }
  }

  _wireBack() {
    this.querySelector("[data-admin-back]")?.addEventListener("click", () =>
      backOrNavigate("/today"),
    );
  }

  _render() {
    const site = this._site;
    const address = site.address || {};
    const contact = site.contactPerson || {};
    const oversight = site.oversight || {};
    const compliance = site.compliance || {};
    const letters = site.complianceLetters || {};
    const current = letters.current;
    const addressLine = [
      `${text(address.streetNumber)} ${text(address.streetAddress)}`.trim(),
      text(address.secondLine),
      `${text(address.city)}, ${text(address.state)} ${text(address.zip)}`.trim(),
    ]
      .filter(Boolean)
      .join(", ");
    const contactName = [contact.firstName, contact.lastName]
      .map(text)
      .filter(Boolean)
      .join(" ");
    const tier = compliance.currentTier
      ? `Tier ${compliance.currentTier}`
      : EMPTY;
    const period = compliance.periodStart
      ? `${formatAdminDate(compliance.periodStart)} – ${formatAdminDate(compliance.periodEnd)}`
      : EMPTY;

    this.innerHTML = html`
      <div class="site-admin-page">
        ${adminHeader("Site information")}
        <div class="site-admin-content">
          ${editableSection("Site details", "site", [
            ["Site name", site.name],
            ["Address", addressLine],
          ])}
          ${editableSection("Contact person", "contact", [
            ["Name", contactName],
            ["Email", contact.email],
            ["Phone", formatAdminPhone(contact.phone)],
          ])}
          ${readOnlySection("Oversight", [
            ["Managing City department", oversight.managingCityDepartment],
            ["Managing system of care", oversight.managingSystemOfCare],
            ["City program manager", oversight.cityProgramManager],
          ])}
          ${readOnlySection("Compliance", [
            ["Current tier", tier],
            ["Tier period", period],
            ["Required checks per day", compliance.requiredChecksPerDay],
          ])}
          <section class="site-admin-section">
            <h2>Perimeter</h2>
            <div class="site-admin-card site-admin-card--prose">
              ${display(site.perimeter)}
            </div>
          </section>
          <section class="site-admin-section">
            <div class="site-admin-section-heading">
              <h2>Access &amp; devices</h2>
              <button type="button" data-access-devices>Manage</button>
            </div>
            <div class="site-admin-card site-admin-card--prose">
              ${escapeHtml(formatDeviceEnrollmentSummary(this._bindings))}
            </div>
          </section>
          <section class="site-admin-section">
            <h2>Compliance letters</h2>
            ${current
              ? letterCard(
                  "Current letter",
                  `Effective ${formatAdminDate(current.effectiveStart)}`,
                  current.url,
                )
              : html`<div class="site-admin-card site-admin-letters">
                  <p class="site-admin-empty">No current letter</p>
                </div>`}
          </section>
          <section class="site-admin-section">
            <h2>Past compliance letters</h2>
            <div class="site-admin-card site-admin-letters">
              ${(letters.past || []).length
                ? letters.past
                    .map((letter) =>
                      letterRow(
                        `${formatAdminDate(letter.effectiveStart)} – ${formatAdminDate(letter.effectiveEnd)}`,
                        letter.url,
                      ),
                    )
                    .join("")
                : html`<p class="site-admin-empty">No past letters</p>`}
            </div>
          </section>
        </div>
      </div>
    `;
    this._wireBack();
    this.querySelectorAll("[data-edit-section]").forEach((button) => {
      button.addEventListener("click", () =>
        navigate(
          `/site-admin/edit/${button.getAttribute("data-edit-section")}`,
        ),
      );
    });
    this.querySelector("[data-access-devices]")?.addEventListener("click", () =>
      navigate("/site-admin/access"),
    );
  }
}

class SiteAccessView extends HTMLElement {
  async connectedCallback() {
    const binding = await getSite();
    if (!hasAdminAccess(binding)) {
      navigate("/today");
      return;
    }
    this._site = binding;
    this._secretUrl = "";
    this._activeGrant = null;
    this.innerHTML = loadingView("Manage access");
    await this._load();
  }

  async _load() {
    try {
      const [devices, currentGrant] = await Promise.all([
        listManagerDeviceBindings(),
        getCurrentStaffEnrollmentGrant(),
      ]);
      this._bindings = devices.bindings || [];
      this._activeGrant =
        currentGrant.grant?.status === "pending" ? currentGrant.grant : null;
      this._render();
      announceScreenHeading(this, ".site-admin-header h1");
    } catch {
      this.innerHTML = errorView("We couldn't load the registered devices.");
      this._wireBack();
    }
  }

  disconnectedCallback() {
    clearInterval(this._countdownTimer);
  }

  _wireBack() {
    this.querySelector("[data-admin-back]")?.addEventListener("click", () =>
      backOrNavigate("/site-admin"),
    );
  }

  _render() {
    this.innerHTML = html`
      <div class="site-admin-page">
        ${adminHeader("Manage access")}
        <div class="site-admin-content">
          <section
            class="site-admin-section"
            aria-labelledby="enroll-team-title"
          >
            <h2 id="enroll-team-title">Enroll a team member's device</h2>
            <form
              class="site-admin-card site-access-form"
              id="staff-grant-form"
            >
              <wa-input
                id="staff-device-label"
                name="label"
                label="Give the new device a name, e.g., Amisha's iPhone"
                maxlength="100"
                autocomplete="off"
                required
                style="--wa-form-control-required-content: ''"
                ${this._activeGrant ? "disabled" : ""}
              ></wa-input>
              <p class="site-access-help">
                Create one 10-minute, single-use enrollment link. Finish sharing
                it before creating another.
              </p>
              <p
                class="site-admin-form-error"
                id="staff-grant-error"
                role="alert"
              ></p>
              <button
                class="btn-ink"
                type="submit"
                ${this._activeGrant ? "disabled" : ""}
              >
                Create enrollment link
              </button>
            </form>
            <div
              class="site-access-grant"
              id="staff-grant-result"
              aria-live="polite"
            >
              ${this._activeGrant
                ? activeGrantView(this._activeGrant, false)
                : ""}
            </div>
          </section>
          <section
            class="site-admin-section"
            aria-labelledby="team-devices-title"
          >
            <h2 id="team-devices-title">Team devices</h2>
            <div class="site-admin-card site-access-list">
              ${this._bindings.length
                ? this._bindings.map(deviceRow).join("")
                : html`<p class="site-admin-empty">
                    No team devices enrolled.
                  </p>`}
            </div>
          </section>
        </div>
        <dialog
          class="places-modal logout-dialog site-access-revoke-dialog"
          id="site-access-revoke-dialog"
          aria-labelledby="site-access-revoke-title"
          aria-describedby="site-access-revoke-copy"
        >
          <form class="places-modal__card" method="dialog">
            <div class="places-modal__copy">
              <h2 class="places-modal__title" id="site-access-revoke-title">
                Revoke this team member's device?
              </h2>
              <p
                class="places-modal__text"
                id="site-access-revoke-copy"
                data-revoke-device-copy
              ></p>
              <p
                class="logout-dialog__error"
                data-revoke-device-error
                role="alert"
                hidden
              ></p>
            </div>
            <div class="places-modal__actions logout-dialog__actions">
              <button
                class="btn-outline logout-dialog__cancel"
                type="submit"
                value="cancel"
                data-cancel-device-revoke
              >
                Cancel
              </button>
              <button
                class="logout-dialog__confirm"
                type="button"
                data-confirm-device-revoke
              >
                Revoke device
              </button>
            </div>
          </form>
        </dialog>
      </div>
    `;
    this._wireBack();
    this.querySelector("#staff-grant-form")?.addEventListener(
      "submit",
      (event) => void this._createGrant(event),
    );
    this.querySelectorAll("[data-revoke-team-device]").forEach((button) => {
      button.addEventListener("click", () =>
        this._openRevokeDialog(
          button.getAttribute("data-revoke-team-device") || "",
          button.getAttribute("data-revoke-team-device-label") || "Team device",
        ),
      );
    });
    this.querySelector("[data-confirm-device-revoke]")?.addEventListener(
      "click",
      () => void this._confirmRevoke(),
    );
    this.querySelector("#site-access-revoke-dialog")?.addEventListener(
      "cancel",
      (event) => {
        if (this._revoking) event.preventDefault();
      },
    );
    this.querySelector("#site-access-revoke-dialog")?.addEventListener(
      "close",
      () => {
        if (!this._revoking) this._pendingRevokeBindingId = "";
      },
    );
    this.querySelector("[data-cancel-staff-grant]")?.addEventListener(
      "click",
      () => void this._cancelGrant(),
    );
    this._startCountdown();
  }

  async _createGrant(event) {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const label = String(
      /** @type {any} */ (form.querySelector("#staff-device-label"))?.value ||
        "",
    ).trim();
    const error = this.querySelector("#staff-grant-error");
    if (!label) {
      if (error)
        error.textContent = "Enter a label for the team member's device.";
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button?.setAttribute("disabled", "");
    if (error) error.textContent = "";
    try {
      const result = await createStaffEnrollmentGrant(label);
      this._secretUrl = result.enrollmentUrl;
      this._activeGrant = result.grant;
      const output = this.querySelector("#staff-grant-result");
      if (output) {
        output.innerHTML = activeGrantView(result.grant, true);
        void renderEnrollmentQr(output, this._secretUrl);
        output
          .querySelector("#share-staff-grant")
          ?.addEventListener("click", () => void this._shareGrant());
        output
          .querySelector("[data-cancel-staff-grant]")
          ?.addEventListener("click", () => void this._cancelGrant());
        this._startCountdown();
      }
    } catch (caught) {
      if (error) {
        error.textContent =
          caught?.status === 409
            ? "Finish or wait for the current enrollment link to expire before creating another."
            : "We couldn't create the enrollment link. Try again.";
      }
      button?.removeAttribute("disabled");
    }
  }

  async _cancelGrant() {
    if (!this._activeGrant?.grantId) return;
    const button = this.querySelector("[data-cancel-staff-grant]");
    button?.setAttribute("disabled", "");
    try {
      await cancelStaffEnrollmentGrant(this._activeGrant.grantId);
      this._secretUrl = "";
      this._activeGrant = null;
      clearInterval(this._countdownTimer);
      await this._load();
    } catch {
      button?.removeAttribute("disabled");
      const error = this.querySelector("#staff-grant-error");
      if (error)
        error.textContent =
          "We couldn't cancel that enrollment link. Try again.";
    }
  }

  _startCountdown() {
    clearInterval(this._countdownTimer);
    if (!this._activeGrant) return;
    const update = () => {
      const countdown = this.querySelector("[data-grant-countdown]");
      if (!countdown || !this._activeGrant) return;
      const remaining = Math.max(
        0,
        Date.parse(this._activeGrant.expiresAt) - Date.now(),
      );
      countdown.textContent = formatCountdown(remaining);
      if (remaining === 0) {
        clearInterval(this._countdownTimer);
        this._secretUrl = "";
        this._activeGrant = null;
        void this._load();
      }
    };
    update();
    this._countdownTimer = setInterval(update, 1000);
  }

  async _shareGrant() {
    if (!this._secretUrl) return;
    if (navigator.share) {
      await navigator.share({
        title: "Good Neighbor enrollment",
        url: this._secretUrl,
      });
      return;
    }
    await navigator.clipboard.writeText(this._secretUrl);
    const button = this.querySelector("#share-staff-grant");
    if (button) button.textContent = "Enrollment link copied";
  }

  _openRevokeDialog(bindingId, label) {
    if (!bindingId) return;
    this._pendingRevokeBindingId = bindingId;
    const copy = this.querySelector("[data-revoke-device-copy]");
    if (copy) {
      copy.textContent = `“${label}” will immediately lose access to ${this._site?.name || "this Site"} on this device. They’ll need a new enrollment link to regain access.`;
    }
    const error = /** @type {HTMLElement | null} */ (
      this.querySelector("[data-revoke-device-error]")
    );
    if (error) {
      error.textContent = "";
      error.hidden = true;
    }
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#site-access-revoke-dialog")
    );
    if (dialog && !dialog.open) dialog.showModal();
  }

  async _confirmRevoke() {
    const bindingId = this._pendingRevokeBindingId;
    if (!bindingId || this._revoking) return;
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#site-access-revoke-dialog")
    );
    const confirm = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-confirm-device-revoke]")
    );
    const cancel = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-cancel-device-revoke]")
    );
    const error = /** @type {HTMLElement | null} */ (
      this.querySelector("[data-revoke-device-error]")
    );
    this._revoking = true;
    if (confirm) {
      confirm.disabled = true;
      confirm.textContent = "Revoking…";
    }
    if (cancel) cancel.disabled = true;
    try {
      await revokeManagerDeviceBinding(bindingId);
      this._pendingRevokeBindingId = "";
      dialog?.close("revoked");
      await this._load();
    } catch {
      if (error) {
        error.textContent = "We couldn't revoke this device. Try again.";
        error.hidden = false;
      }
      if (confirm) {
        confirm.disabled = false;
        confirm.textContent = "Revoke device";
      }
      if (cancel) cancel.disabled = false;
    } finally {
      this._revoking = false;
    }
  }
}

class SiteAdminEdit extends HTMLElement {
  async connectedCallback() {
    const binding = await getSite();
    if (!hasAdminAccess(binding)) {
      navigate("/today");
      return;
    }
    this._kind = currentRoute().endsWith("/contact") ? "contact" : "site";
    this.innerHTML = loadingView(this._title());
    try {
      this._site = (await getSiteAdmin()).site;
      this._original = this._sectionValue();
      this._render();
      this._installLeaveGuards();
      announceScreenHeading(this, ".site-admin-header h1");
    } catch {
      this.innerHTML = errorView("We couldn't load this form.");
      this.querySelector("[data-admin-back]")?.addEventListener("click", () =>
        backOrNavigate("/site-admin"),
      );
    }
  }

  disconnectedCallback() {
    this._removePopstateGuard?.();
    if (this._beforeUnload) {
      window.removeEventListener("beforeunload", this._beforeUnload);
    }
  }

  _title() {
    return this._kind === "contact"
      ? "Edit contact person"
      : "Edit site details";
  }

  _sectionValue() {
    if (this._kind === "contact") {
      const contact = this._site.contactPerson || {};
      return {
        firstName: text(contact.firstName),
        lastName: text(contact.lastName),
        email: text(contact.email),
        phone: formatAdminPhone(contact.phone),
      };
    }
    const address = this._site.address || {};
    return {
      name: text(this._site.name),
      address: {
        streetNumber: text(address.streetNumber),
        streetAddress: text(address.streetAddress),
        secondLine: text(address.secondLine),
        city: text(address.city),
        state: text(address.state),
        zip: text(address.zip),
      },
    };
  }

  _render() {
    this.innerHTML = html`
      <div class="site-admin-page">
        ${adminHeader(this._title())}
        <div class="site-admin-edit">
          <form id="site-admin-form" novalidate>
            <div class="site-admin-fields">
              ${this._kind === "contact"
                ? contactFields(this._original)
                : siteFields(this._original)}
            </div>
            <p
              class="site-admin-form-error"
              id="site-admin-form-error"
              role="alert"
            ></p>
            <div class="site-admin-edit-actions">
              <button class="btn-outline" id="site-admin-cancel" type="button">
                Cancel
              </button>
              <button
                class="btn-ink"
                id="site-admin-save"
                type="submit"
                disabled
              >
                Save changes
              </button>
            </div>
          </form>
        </div>
        <dialog
          class="places-modal site-admin-discard-dialog"
          id="site-admin-discard-dialog"
        >
          <form class="places-modal__card" method="dialog">
            <div class="places-modal__copy">
              <h2 class="places-modal__title">Discard your changes?</h2>
              <p class="places-modal__text">Your edits haven't been saved.</p>
            </div>
            <div class="places-modal__actions">
              <button class="btn-outline" id="site-admin-keep" value="keep">
                Keep editing
              </button>
              <button
                class="places-modal__danger"
                id="site-admin-discard"
                value="discard"
              >
                Discard changes
              </button>
            </div>
          </form>
        </dialog>
      </div>
    `;
    this.querySelector("#site-admin-form")?.addEventListener("input", () =>
      this._syncDirty(),
    );
    this.querySelector("#site-admin-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this._save();
      },
    );
    this.querySelector("[data-admin-back]")?.addEventListener(
      "click",
      () => void this._attemptBack(),
    );
    this.querySelector("#site-admin-cancel")?.addEventListener(
      "click",
      () => void this._attemptBack(),
    );
  }

  _value() {
    /** @param {string} id */
    const value = (id) =>
      text(/** @type {any} */ (this.querySelector(id))?.value);
    return this._kind === "contact"
      ? {
          firstName: value("#admin-first-name"),
          lastName: value("#admin-last-name"),
          email: value("#admin-email"),
          phone: value("#admin-phone"),
        }
      : {
          name: value("#admin-site-name"),
          address: {
            streetNumber: value("#admin-street-number"),
            streetAddress: value("#admin-street-address"),
            secondLine: value("#admin-second-line"),
            city: value("#admin-city"),
            state: value("#admin-state"),
            zip: value("#admin-zip"),
          },
        };
  }

  _syncDirty() {
    const save = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("#site-admin-save")
    );
    if (save) save.disabled = !valuesChanged(this._original, this._value());
    const error = this.querySelector("#site-admin-form-error");
    if (error) error.textContent = "";
  }

  _isDirty() {
    return valuesChanged(this._original, this._value());
  }

  _installLeaveGuards() {
    this._removePopstateGuard = setPopstateGuard(async () => {
      if (this._allowLeave || !this._isDirty()) return true;
      const discard = await this._confirmDiscard();
      if (discard) this._allowLeave = true;
      return discard;
    });
    this._beforeUnload = (event) => {
      if (this._allowLeave || !this._isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", this._beforeUnload);
  }

  async _attemptBack() {
    if (!this._isDirty()) {
      backOrNavigate("/site-admin");
      return;
    }
    if (await this._confirmDiscard()) {
      this._allowLeave = true;
      backOrNavigate("/site-admin");
    }
  }

  _confirmDiscard() {
    if (this._discardPromise) return this._discardPromise;
    const dialog = this._dialog();
    dialog?.showModal();
    this._discardPromise = new Promise((resolve) => {
      dialog?.addEventListener(
        "close",
        () => {
          this._discardPromise = null;
          resolve(dialog.returnValue === "discard");
        },
        { once: true },
      );
    });
    return this._discardPromise;
  }

  _dialog() {
    return /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#site-admin-discard-dialog")
    );
  }

  async _save() {
    const value = this._value();
    const message =
      this._kind === "contact"
        ? validateContact(value)
        : validateSiteDetails(value);
    const error = /** @type {HTMLElement | null} */ (
      this.querySelector("#site-admin-form-error")
    );
    if (message) {
      if (error) error.textContent = message;
      return;
    }
    const save = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("#site-admin-save")
    );
    if (save) {
      save.disabled = true;
      save.textContent = "Saving…";
    }
    try {
      await updateSiteAdmin(
        this._kind === "contact" ? "contactPerson" : "siteDetails",
        value,
      );
      if (this._kind === "site") {
        await saveSiteSettings({ name: value.name });
      }
      this._allowLeave = true;
      showSiteAdminSuccessToast();
      backOrNavigate("/site-admin");
    } catch {
      showSiteAdminErrorToast();
      if (save) {
        save.disabled = false;
        save.textContent = "Save changes";
      }
    }
  }
}

/** @param {string} title */
function adminHeader(title) {
  return html`<header class="site-admin-header">
    <button data-admin-back type="button" aria-label="Back">
      <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
    </button>
    <h1 tabindex="-1">${escapeHtml(title)}</h1>
    <span aria-hidden="true"></span>
  </header>`;
}

/** @param {string} title */
function loadingView(title) {
  return html`<div class="site-admin-page">
    ${adminHeader(title)}
    <div class="site-admin-loading"><wa-spinner></wa-spinner> Loading…</div>
  </div>`;
}

/** @param {string} message */
function errorView(message) {
  return html`<div class="site-admin-page">
    ${adminHeader("Site information")}
    <p class="site-admin-load-error" role="alert">${escapeHtml(message)}</p>
  </div>`;
}

/** @param {string} title @param {string} route @param {Array<[string, unknown]>} rows */
function editableSection(title, route, rows) {
  return html`<section class="site-admin-section">
    <div class="site-admin-section-heading">
      <h2>${escapeHtml(title)}</h2>
      <button type="button" data-edit-section="${escapeAttr(route)}">
        <wa-icon name="pen" aria-hidden="true"></wa-icon> Edit
      </button>
    </div>
    ${rowsCard(rows)}
  </section>`;
}

/** @param {string} title @param {Array<[string, unknown]>} rows */
function readOnlySection(title, rows) {
  return html`<section class="site-admin-section">
    <h2>${escapeHtml(title)}</h2>
    ${rowsCard(rows)}
  </section>`;
}

/** @param {Array<[string, unknown]>} rows */
function rowsCard(rows) {
  return html`<dl class="site-admin-card site-admin-rows">
    ${rows
      .map(
        ([label, value]) =>
          html`<div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${display(value)}</dd>
          </div>`,
      )
      .join("")}
  </dl>`;
}

/** @param {string} title @param {string} detail @param {string} url */
function letterCard(title, detail, url) {
  return html`<div class="site-admin-card site-admin-letter-current">
    <wa-icon name="file-lines" aria-hidden="true"></wa-icon>
    <div>
      <strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>
    </div>
    <a href="${escapeAttr(url)}" target="_blank" rel="noopener">Open PDF</a>
  </div>`;
}

/** @param {string} dateRange @param {string} url */
function letterRow(dateRange, url) {
  return html`<div class="site-admin-letter-row">
    <strong>${escapeHtml(dateRange)}</strong>
    <a href="${escapeAttr(url)}" target="_blank" rel="noopener">Open PDF</a>
  </div>`;
}

/** @param {Record<string, any>} value */
function contactFields(value) {
  return [
    field(
      "admin-first-name",
      "First name",
      value.firstName,
      "given-name",
      "text",
    ),
    field(
      "admin-last-name",
      "Last name",
      value.lastName,
      "family-name",
      "text",
    ),
    field("admin-email", "Email", value.email, "email", "email"),
    field("admin-phone", "Phone", value.phone, "tel", "tel"),
  ].join("");
}

/** @param {Record<string, any>} value */
function siteFields(value) {
  const address = value.address;
  return [
    field("admin-site-name", "Site name", value.name, "organization", "text"),
    field(
      "admin-street-number",
      "Street number",
      address.streetNumber,
      "address-line1",
      "text",
    ),
    field(
      "admin-street-address",
      "Street address",
      address.streetAddress,
      "address-line1",
      "text",
    ),
    field(
      "admin-second-line",
      "Second line",
      address.secondLine,
      "address-line2",
      "text",
      false,
    ),
    field("admin-city", "City", address.city, "address-level2", "text"),
    field("admin-state", "State", address.state, "address-level1", "text"),
    field("admin-zip", "ZIP", address.zip, "postal-code", "text"),
  ].join("");
}

function field(id, label, value, autocomplete, type, required = true) {
  return html`<wa-input
    id="${id}"
    label="${escapeAttr(label)}"
    value="${escapeAttr(value)}"
    autocomplete="${autocomplete}"
    type="${type}"
    size="large"
    ${required ? "required" : ""}
  ></wa-input>`;
}

/** @param {Record<string, any>} binding */
function deviceRow(binding) {
  return html`<article class="site-access-device">
    <div>
      <h3>${escapeHtml(binding.label || "Team device")}</h3>
      <p>
        ${escapeHtml(binding.status || "active")} · Last seen
        ${escapeHtml(formatTimestamp(binding.lastSeenAt))}
      </p>
    </div>
    ${binding.status === "active"
      ? html`<button
          class="btn-outline"
          type="button"
          data-revoke-team-device="${escapeAttr(binding.bindingId)}"
          data-revoke-team-device-label="${escapeAttr(
            binding.label || "Team device",
          )}"
        >
          Revoke
        </button>`
      : ""}
  </article>`;
}

/** @param {Record<string, any>} grant @param {boolean} showSecretActions */
function activeGrantView(grant, showSecretActions) {
  return html`<div class="site-admin-card site-access-ready">
    <h3>
      ${showSecretActions ? "Enrollment QR ready" : "Enrollment in progress"}
    </h3>
    <p>
      For ${escapeHtml(grant.label)}. Expires in
      <strong data-grant-countdown
        >${escapeHtml(
          formatCountdown(
            Math.max(0, Date.parse(grant.expiresAt) - Date.now()),
          ),
        )}</strong
      >. It works once.
    </p>
    ${showSecretActions
      ? html`<wa-qr-code
            size="220"
            error-correction="M"
            label="Scan to enroll ${escapeAttr(grant.label)} for this Site"
          ></wa-qr-code>
          <button class="btn-outline" type="button" id="share-staff-grant">
            Share enrollment link
          </button>`
      : html`<p>
          The secret link is no longer shown after leaving this screen. Cancel
          it to create a replacement.
        </p>`}
    <button class="btn-outline" type="button" data-cancel-staff-grant>
      Cancel enrollment link
    </button>
  </div>`;
}

/** @param {number} milliseconds */
function formatCountdown(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** @param {Element} container @param {string} value */
async function renderEnrollmentQr(container, value) {
  await import("@awesome.me/webawesome/dist/components/qr-code/qr-code.js");
  const qrCode = /** @type {any} */ (container.querySelector("wa-qr-code"));
  if (qrCode?.isConnected) qrCode.value = value;
}

/** @param {unknown} value */
function formatTimestamp(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return EMPTY;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

customElements.define("site-admin-view", SiteAdminView);
customElements.define("site-admin-edit", SiteAdminEdit);
customElements.define("site-access-view", SiteAccessView);
