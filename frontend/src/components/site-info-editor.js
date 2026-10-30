import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
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
import { showSiteAdminErrorToast } from "../state/toasts.js";
import {
  formatAdminPhone,
  validateContact,
  validateSiteDetails,
  valuesChanged,
} from "./site-admin.validation.js";
import {
  adminHeader,
  loadingView,
  errorView,
  field,
} from "./site-info-shell.js";
const text = (value) => String(value || "").trim();
const CONTACT_FIELDS = [
  ["email", "email", "email", "email"],
  ["phone", "phone", "tel", "tel"],
  ["phoneExtension", "phone-extension", "tel-extension", "text"],
];
const ADDRESS_FIELDS = [
  ["streetNumber", "street-number", "address-line1"],
  ["streetAddress", "street-address", "address-line1"],
  ["secondLine", "second-line", "address-line2"],
  ["city", "city", "address-level2"],
  ["state", "state", "address-level1"],
  ["zip", "zip", "postal-code"],
];

class SiteAdminEdit extends HTMLElement {
  async connectedCallback() {
    const binding = await getSite();
    if (!hasAdminAccess(binding)) {
      navigate("/today");
      return;
    }
    const route = currentRoute();
    this._kind = route.includes("/manager/")
      ? "manager"
      : route.endsWith("/perimeter")
        ? "perimeter"
        : route.endsWith("/contact")
          ? "contact"
          : "site";
    this._personId =
      this._kind === "manager"
        ? decodeURIComponent(route.split("/").at(-1))
        : "";
    this.innerHTML = loadingView(this._title());
    try {
      this._site = (await getSiteAdmin()).site;
      this._original = this._sectionValue();
      this._render();
      this._installLeaveGuards();
      announceScreenHeading(this, ".site-admin-header h1");
    } catch {
      this.innerHTML = errorView(t("siteAdmin.formLoadError"));
      this.querySelector("[data-load-retry]")?.addEventListener(
        "click",
        () => void this.connectedCallback(),
      );
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
    if (this._kind === "perimeter") return t("siteAdmin.perimeter.editTitle");
    if (this._kind === "manager") return t("siteAdmin.managers.editPhone");
    return this._kind === "contact"
      ? t("siteAdmin.edit.contactTitle")
      : t("siteAdmin.edit.siteTitle");
  }

  /** @returns {Record<string, any>} */
  _sectionValue() {
    if (this._kind === "perimeter")
      return { perimeter: text(this._site.perimeter) };
    if (this._kind === "manager") {
      const person = (this._site.siteManagers || []).find(
        (item) => item.personId === this._personId && item.canEditPhone,
      );
      if (!person) throw new Error("assigned_person_not_found");
      this._person = person;
      return {
        personId: person.personId,
        phone: formatAdminPhone(person.phone),
      };
    }
    if (this._kind === "contact") {
      const contact = this._site.publicContact || {};
      return Object.fromEntries(
        CONTACT_FIELDS.map(([key]) => [
          key,
          key === "phone" ? formatAdminPhone(contact[key]) : text(contact[key]),
        ]),
      );
    }
    const address = this._site.address || {};
    return {
      name: text(this._site.name),
      address: Object.fromEntries(
        ADDRESS_FIELDS.map(([key]) => [key, text(address[key])]),
      ),
    };
  }

  _render() {
    this.innerHTML = html`
      <div class="site-admin-page">
        ${adminHeader(this._title())}
        <div class="site-admin-edit">
          <form id="site-admin-form" novalidate>
            <div class="site-admin-fields">
              ${this._kind === "perimeter"
                ? html`<wa-textarea
                    id="admin-perimeter"
                    label="${escapeAttr(t("siteAdmin.perimeter.title"))}"
                    value="${escapeAttr(this._original.perimeter)}"
                    rows="8"
                    maxlength="4000"
                    required
                  ></wa-textarea>`
                : this._kind === "manager"
                  ? html`<p>
                        ${escapeHtml(this._person.name)}<br />${escapeHtml(
                          this._person.email,
                        )}
                      </p>
                      ${field(
                        "admin-phone",
                        t("siteAdmin.field.phone"),
                        this._original.phone,
                        "tel",
                        "tel",
                        false,
                      )}`
                  : this._kind === "contact"
                    ? formFields(CONTACT_FIELDS, this._original)
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

  /** @returns {Record<string, any>} */
  _value() {
    /** @param {string} id */
    const value = (id) =>
      text(/** @type {any} */ (this.querySelector(id))?.value);
    if (this._kind === "perimeter")
      return { perimeter: value("#admin-perimeter") };
    if (this._kind === "manager")
      return { personId: this._personId, phone: value("#admin-phone") };
    return this._kind === "contact"
      ? Object.fromEntries(
          CONTACT_FIELDS.map(([key, id]) => [key, value(`#admin-${id}`)]),
        )
      : {
          name: value("#admin-site-name"),
          address: Object.fromEntries(
            ADDRESS_FIELDS.map(([key, id]) => [key, value(`#admin-${id}`)]),
          ),
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
      this._kind === "perimeter"
        ? !value.perimeter || value.perimeter.length > 4000
          ? t("siteAdmin.validation.perimeter")
          : ""
        : this._kind === "manager"
          ? validateContact({ phone: value.phone })
          : this._kind === "contact"
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
        this._kind === "manager"
          ? "siteManagerPhone"
          : this._kind === "perimeter"
            ? "perimeter"
            : this._kind === "contact"
              ? "publicContact"
              : "siteDetails",
        value,
      );
      if (this._kind === "site") {
        await saveSiteSettings({ name: value.name });
      }
      this._allowLeave = true;
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

/** @param {string[][]} fields @param {Record<string, any>} value */
function formFields(fields, value) {
  return fields
    .map(([key, id, autocomplete, type = "text"]) =>
      field(
        `admin-${id}`,
        t(`siteAdmin.field.${key}`),
        value[key],
        autocomplete,
        type,
        ADDRESS_FIELDS === fields && key !== "secondLine",
      ),
    )
    .join("");
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
    formFields(ADDRESS_FIELDS, address),
  ].join("");
}

customElements.define("site-info-editor", SiteAdminEdit);
