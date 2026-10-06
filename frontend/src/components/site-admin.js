import "./site-admin.css";
import "@awesome.me/webawesome/dist/components/input/input.js";
import { getSite, hasAdminAccess, saveSiteSettings } from "../db.js";
import { t } from "../i18n/i18n.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import {
  backOrNavigate,
  currentRoute,
  navigate,
  setPopstateGuard,
} from "../router.js";
import { getSiteAdmin, updateSiteAdmin } from "../services/api.js";
import { announceScreenHeading } from "../screen-focus.js";
import {
  showSiteAdminErrorToast,
  showSiteAdminSuccessToast,
} from "../state/toasts.js";
import {
  formatAdminDate,
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
    this.innerHTML = loadingView(t("siteAdmin.title"));
    try {
      this._site = (await getSiteAdmin()).site;
      this._render();
      announceScreenHeading(this, ".site-admin-header h1");
    } catch {
      this.innerHTML = errorView(t("siteAdmin.loadError"));
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
      ? t("siteAdmin.compliance.tier", { tier: compliance.currentTier })
      : EMPTY;
    const period = compliance.periodStart
      ? t("siteAdmin.dateRange", {
          start: formatAdminDate(compliance.periodStart),
          end: formatAdminDate(compliance.periodEnd),
        })
      : EMPTY;

    this.innerHTML = html`
      <div class="site-admin-page">
        ${adminHeader(t("siteAdmin.title"))}
        <div class="site-admin-content">
          ${editableSection(t("siteAdmin.siteDetails.title"), "site", [
            [t("siteAdmin.field.siteName"), site.name],
            [t("siteAdmin.siteDetails.address"), addressLine],
          ])}
          ${editableSection(t("siteAdmin.contact.title"), "contact", [
            [t("siteAdmin.contact.name"), contactName],
            [t("siteAdmin.field.email"), contact.email],
            [t("siteAdmin.field.phone"), formatAdminPhone(contact.phone)],
          ])}
          ${readOnlySection(t("siteAdmin.oversight.title"), [
            [
              t("siteAdmin.oversight.department"),
              oversight.managingCityDepartment,
            ],
            [
              t("siteAdmin.oversight.systemOfCare"),
              oversight.managingSystemOfCare,
            ],
            [
              t("siteAdmin.oversight.programManager"),
              oversight.cityProgramManager,
            ],
          ])}
          ${readOnlySection(t("siteAdmin.compliance.title"), [
            [t("siteAdmin.compliance.currentTier"), tier],
            [t("siteAdmin.compliance.tierPeriod"), period],
            [
              t("siteAdmin.compliance.checksPerDay"),
              compliance.requiredChecksPerDay,
            ],
          ])}
          <section class="site-admin-section">
            <h2>${escapeHtml(t("siteAdmin.perimeter.title"))}</h2>
            <div class="site-admin-card site-admin-card--prose">
              ${display(site.perimeter)}
            </div>
          </section>
          <section class="site-admin-section">
            <h2>${escapeHtml(t("siteAdmin.letters.title"))}</h2>
            ${current
              ? letterCard(
                  t("siteAdmin.letters.current"),
                  t("siteAdmin.letters.effective", {
                    date: formatAdminDate(current.effectiveStart),
                  }),
                  current.url,
                )
              : html`<div class="site-admin-card">
                  ${escapeHtml(t("siteAdmin.letters.noCurrent"))}
                </div>`}
          </section>
          <section class="site-admin-section">
            <h2>${escapeHtml(t("siteAdmin.letters.pastTitle"))}</h2>
            <div class="site-admin-card site-admin-letters">
              ${(letters.past || []).length
                ? letters.past
                    .map((letter) =>
                      letterRow(
                        t("siteAdmin.dateRange", {
                          start: formatAdminDate(letter.effectiveStart),
                          end: formatAdminDate(letter.effectiveEnd),
                        }),
                        letter.url,
                      ),
                    )
                    .join("")
                : html`<p class="site-admin-empty">
                    ${escapeHtml(t("siteAdmin.letters.noPast"))}
                  </p>`}
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
      this.innerHTML = errorView(t("siteAdmin.formLoadError"));
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
      ? t("siteAdmin.edit.contactTitle")
      : t("siteAdmin.edit.siteTitle");
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
                ${escapeHtml(t("common.cancel"))}
              </button>
              <button
                class="btn-ink"
                id="site-admin-save"
                type="submit"
                disabled
              >
                ${escapeHtml(t("siteAdmin.edit.save"))}
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
              <h2 class="places-modal__title">
                ${escapeHtml(t("siteAdmin.discard.title"))}
              </h2>
              <p class="places-modal__text">
                ${escapeHtml(t("siteAdmin.discard.text"))}
              </p>
            </div>
            <div class="places-modal__actions">
              <button class="btn-outline" id="site-admin-keep" value="keep">
                ${escapeHtml(t("common.keepEditing"))}
              </button>
              <button
                class="places-modal__danger"
                id="site-admin-discard"
                value="discard"
              >
                ${escapeHtml(t("common.discardChanges"))}
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
      save.textContent = t("siteAdmin.edit.saving");
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
        save.textContent = t("siteAdmin.edit.save");
      }
    }
  }
}

/** @param {string} title */
function adminHeader(title) {
  return html`<header class="site-admin-header">
    <button
      data-admin-back
      type="button"
      aria-label="${escapeAttr(t("common.back"))}"
    >
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
    <div class="site-admin-loading">
      <wa-spinner></wa-spinner> ${escapeHtml(t("common.loading"))}
    </div>
  </div>`;
}

/** @param {string} message */
function errorView(message) {
  return html`<div class="site-admin-page">
    ${adminHeader(t("siteAdmin.title"))}
    <p class="site-admin-load-error" role="alert">${escapeHtml(message)}</p>
  </div>`;
}

/** @param {string} title @param {string} route @param {Array<[string, unknown]>} rows */
function editableSection(title, route, rows) {
  return html`<section class="site-admin-section">
    <div class="site-admin-section-heading">
      <h2>${escapeHtml(title)}</h2>
      <button type="button" data-edit-section="${escapeAttr(route)}">
        <wa-icon name="pen" aria-hidden="true"></wa-icon>
        ${escapeHtml(t("common.edit"))}
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
    <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
      >${escapeHtml(t("siteAdmin.letters.openPdf"))}</a
    >
  </div>`;
}

/** @param {string} dateRange @param {string} url */
function letterRow(dateRange, url) {
  return html`<div class="site-admin-letter-row">
    <strong>${escapeHtml(dateRange)}</strong>
    <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
      >${escapeHtml(t("siteAdmin.letters.openPdf"))}</a
    >
  </div>`;
}

/** @param {Record<string, any>} value */
function contactFields(value) {
  return [
    field(
      "admin-first-name",
      t("siteAdmin.field.firstName"),
      value.firstName,
      "given-name",
      "text",
    ),
    field(
      "admin-last-name",
      t("siteAdmin.field.lastName"),
      value.lastName,
      "family-name",
      "text",
    ),
    field(
      "admin-email",
      t("siteAdmin.field.email"),
      value.email,
      "email",
      "email",
    ),
    field("admin-phone", t("siteAdmin.field.phone"), value.phone, "tel", "tel"),
  ].join("");
}

/** @param {Record<string, any>} value */
function siteFields(value) {
  const address = value.address;
  return [
    field(
      "admin-site-name",
      t("siteAdmin.field.siteName"),
      value.name,
      "organization",
      "text",
    ),
    field(
      "admin-street-number",
      t("siteAdmin.field.streetNumber"),
      address.streetNumber,
      "address-line1",
      "text",
    ),
    field(
      "admin-street-address",
      t("siteAdmin.field.streetAddress"),
      address.streetAddress,
      "address-line1",
      "text",
    ),
    field(
      "admin-second-line",
      t("siteAdmin.field.secondLine"),
      address.secondLine,
      "address-line2",
      "text",
      false,
    ),
    field(
      "admin-city",
      t("siteAdmin.field.city"),
      address.city,
      "address-level2",
      "text",
    ),
    field(
      "admin-state",
      t("siteAdmin.field.state"),
      address.state,
      "address-level1",
      "text",
    ),
    field(
      "admin-zip",
      t("siteAdmin.field.zip"),
      address.zip,
      "postal-code",
      "text",
    ),
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

customElements.define("site-admin-view", SiteAdminView);
customElements.define("site-admin-edit", SiteAdminEdit);
