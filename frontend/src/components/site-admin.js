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
  formatCountdown,
  formatAdminPhone,
  validateContact,
  validateSiteDetails,
  valuesChanged,
} from "./site-admin.validation.js";

const EMPTY = "—";
const CONTACT_FIELDS = [
  ["firstName", "first-name", "given-name", "text"],
  ["lastName", "last-name", "family-name", "text"],
  ["email", "email", "email", "email"],
  ["phone", "phone", "tel", "tel"],
];
const ADDRESS_FIELDS = [
  ["streetNumber", "street-number", "address-line1"],
  ["streetAddress", "street-address", "address-line1"],
  ["secondLine", "second-line", "address-line2"],
  ["city", "city", "address-level2"],
  ["state", "state", "address-level1"],
  ["zip", "zip", "postal-code"],
];

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
      const siteResult = await getSiteAdmin();
      this._site = siteResult.site;
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
    const monitoring = t(
      compliance.underEnhancedMonitoring
        ? "admin.compliance.yes"
        : "admin.compliance.no",
    );
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
            [t("siteAdmin.compliance.enhancedMonitoring"), monitoring],
            [t("siteAdmin.compliance.period"), period],
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
              : html`<div class="site-admin-card site-admin-letters">
                  <p class="site-admin-empty">
                    ${escapeHtml(t("siteAdmin.letters.noCurrent"))}
                  </p>
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

class SiteAccessView extends HTMLElement {
  async connectedCallback() {
    const binding = await getSite();
    if (!hasAdminAccess(binding)) {
      navigate("/today");
      return;
    }
    this._site = binding;
    this._grants = [];
    this.innerHTML = loadingView(t("access.title"));
    await this._load();
  }

  async _load() {
    try {
      const [devices, currentGrant, deviceView, accessState] =
        await Promise.all([
          listManagerDeviceBindings(),
          getCurrentStaffEnrollmentGrant(),
          import("./site-access-devices.js"),
          import("./site-access-state.js"),
        ]);
      if (!this.isConnected) return;
      this._canManageAccess = currentGrant.canManageAccess !== false;
      this._canInviteManagers = currentGrant.canInviteManagers === true;
      if (this._canInviteManagers)
        this._invitationControls = await import("./site-access-roles.js");
      this._deviceView = deviceView;
      this._accessState = accessState;
      this._stopAccessRefresh ||= accessState.observeAccess(this);
      this._bindings = devices.bindings || [];
      const localGrants = new Map(
        this._grants.map((grant) => [grant.grantId, grant]),
      );
      this._grants = (currentGrant.grants || [])
        .filter(
          (grant) =>
            grant.status === "pending" &&
            Date.parse(grant.expiresAt) > Date.now(),
        )
        .map((grant) => ({
          ...grant,
          enrollmentUrl: localGrants.get(grant.grantId)?.enrollmentUrl,
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      this._render();
      announceScreenHeading(this, ".site-admin-header h1");
    } catch {
      this.innerHTML = errorView(t("access.loadError"));
      this._wireBack();
    }
  }

  disconnectedCallback() {
    this._stopAccessRefresh?.();
    this._stopAccessRefresh = null;
    clearInterval(this._countdownTimer);
    this._grants = [];
    this.querySelector("#staff-grant-result")?.replaceChildren();
  }

  _wireBack() {
    this.querySelector("[data-admin-back]")?.addEventListener("click", () =>
      backOrNavigate("/today"),
    );
  }

  _render() {
    this.innerHTML = html`
      <div class="site-admin-page">
        ${adminHeader(t("access.title"))}
        <div class="site-admin-content">
          <section
            class="site-admin-section"
            aria-labelledby="enroll-team-title"
          >
            <h2 id="enroll-team-title">
              ${escapeHtml(
                t("access.siteHeading", {
                  site: this._site.name || t("access.site"),
                }),
              )}
            </h2>
            <form
              class="site-admin-card site-access-form"
              id="staff-grant-form"
            >
              <wa-input
                id="staff-device-label"
                label="${escapeHtml(t("access.deviceLabel"))}"
                placeholder="${escapeAttr(t("access.devicePlaceholder"))}"
                maxlength="100"
                autocomplete="off"
                required
              ></wa-input>
              ${this._invitationControls
                ? html`
                    <wa-radio-group
                      id="invitation-role"
                      label="${escapeAttr(t("access.invitationRole"))}"
                      name="invitation-role"
                      required
                    >
                      <wa-radio value="manager"
                        >${escapeHtml(t("access.role.manager"))}</wa-radio
                      >
                      <wa-radio value="general"
                        >${escapeHtml(t("access.role.general"))}</wa-radio
                      >
                    </wa-radio-group>
                    <div id="invitation-manager-contact" hidden>
                      ${field(
                        "invitation-first-name",
                        t("siteAdmin.field.firstName"),
                        "",
                        "given-name",
                        "text",
                        false,
                      )}
                      ${field(
                        "invitation-last-name",
                        t("siteAdmin.field.lastName"),
                        "",
                        "family-name",
                        "text",
                        false,
                      )}
                      ${field(
                        "invitation-email",
                        t("siteAdmin.field.email"),
                        "",
                        "email",
                        "email",
                        false,
                      )}
                    </div>
                  `
                : ""}
              <p
                class="site-admin-form-error"
                id="staff-grant-error"
                role="alert"
              ></p>
              <button
                class="btn-ink"
                type="submit"
                ${this._canInviteManagers ? "disabled" : ""}
              >
                ${escapeHtml(t("access.create"))}
              </button>
              <p class="site-access-help">${escapeHtml(t("access.help"))}</p>
            </form>
            <div
              class="site-access-grant"
              id="staff-grant-result"
              aria-live="polite"
            >
              ${this._grants
                .map((grant, index) => activeGrantView(grant, index === 0))
                .join("")}
            </div>
          </section>
          <section
            class="site-admin-section"
            aria-labelledby="team-devices-title"
          >
            <h2 id="team-devices-title">${escapeHtml(t("access.devices"))}</h2>
            <div class="site-admin-card site-access-list">
              ${this._bindings.length
                ? this._bindings
                    .map((binding) =>
                      this._deviceView.deviceRow(
                        binding,
                        this._canInviteManagers,
                      ),
                    )
                    .join("")
                : html`<p class="site-admin-empty">
                    ${escapeHtml(t("access.empty"))}
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
                ${escapeHtml(t("access.revokeTitle"))}
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
                ${escapeHtml(t("common.cancel"))}
              </button>
              <button
                class="logout-dialog__confirm"
                type="button"
                data-confirm-device-revoke
              >
                ${escapeHtml(t("access.revoke"))}
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
    const invitationForm = this.querySelector("#staff-grant-form");
    invitationForm?.addEventListener("input", () => this._syncInvitation());
    invitationForm?.addEventListener("change", () => this._syncInvitation());
    this.querySelector(".site-access-list")?.addEventListener(
      "click",
      (event) => {
        const button = /** @type {Element} */ (event.target).closest(
          "[data-revoke-team-device]",
        );
        if (button)
          this._openRevokeDialog(
            button.getAttribute("data-revoke-team-device") || "",
            button.getAttribute("data-revoke-team-device-label") ||
              t("access.device"),
          );
      },
    );
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
    this.querySelectorAll("[data-grant-id]").forEach((card) => {
      const grant = this._grants.find(
        (item) => item.grantId === card.getAttribute("data-grant-id"),
      );
      if (grant.enrollmentUrl)
        void renderEnrollmentQr(card, grant.enrollmentUrl);
      card
        .querySelector("[data-share-grant]")
        ?.addEventListener("click", () => void this._accessState.shareGrant(grant));
      card
        .querySelector("[data-cancel-staff-grant]")
        ?.addEventListener("click", () => void this._cancelGrant(grant));
    });
    this._syncInvitation();
    this._startCountdown();
  }

  _syncInvitation() {
    this._accessState.syncAccess(this);
  }

  async _createGrant(event) {
    event.preventDefault();
    if (this._creatingInvitation || this._canManageAccess === false) return;
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const label = String(
      /** @type {any} */ (form.querySelector("#staff-device-label"))?.value ||
        "",
    ).trim();
    const invitation = this._invitationControls?.readInvitation(this);
    if (
      (invitation?.accessLevel === "manager" && !this._canInviteManagers) ||
      (this._canInviteManagers &&
        !this._invitationControls.validInvitation(invitation))
    ) {
      this._syncInvitation();
      return;
    }
    const error = this.querySelector("#staff-grant-error");
    if (!label) {
      if (error) error.textContent = t("access.labelError");
      return;
    }
    const button = form.querySelector("button[type=submit]");
    this._creatingInvitation = true;
    button?.setAttribute("disabled", "");
    if (error) error.textContent = "";
    try {
      const result = await createStaffEnrollmentGrant(
        label,
        this._canInviteManagers
          ? {
              accessLevel: invitation.accessLevel,
              ...(invitation.accessLevel === "manager"
                ? {
                    firstName: invitation.firstName,
                    lastName: invitation.lastName,
                    email: invitation.email,
                  }
                : {}),
            }
          : {},
      );
      if (!this.isConnected) return;
      this._grants.unshift({
        ...result.grant,
        enrollmentUrl: result.enrollmentUrl,
      });
      this._render();
    } catch (failure) {
      const message = await this._accessState.invitationError(this, failure);
      if (error) error.textContent = t(message);
      button?.removeAttribute("disabled");
    } finally {
      this._creatingInvitation = false;
      this._syncInvitation();
    }
  }

  async _cancelGrant(grant) {
    try {
      await cancelStaffEnrollmentGrant(grant.grantId);
      this._grants = this._grants.filter(
        (item) => item.grantId !== grant.grantId,
      );
      await this._load();
    } catch {
      const error = this.querySelector("#staff-grant-error");
      if (error) error.textContent = t("access.cancelError");
    }
  }

  _startCountdown() {
    clearInterval(this._countdownTimer);
    this._countdownTimer = setInterval(() => void this._refreshGrants(), 5000);
  }

  async _refreshGrants() {
    await this._accessState?.refreshGrants(this);
  }

  _openRevokeDialog(bindingId, label) {
    if (!bindingId) return;
    this._pendingRevokeBindingId = bindingId;
    const copy = this.querySelector("[data-revoke-device-copy]");
    if (copy) {
      copy.textContent = t("access.revokeCopy", {
        label,
        site: this._site?.name || t("access.site"),
      });
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
      confirm.textContent = t("access.revoking");
    }
    if (cancel) cancel.disabled = true;
    try {
      await revokeManagerDeviceBinding(bindingId);
      this._pendingRevokeBindingId = "";
      dialog?.close("revoked");
      await this._load();
    } catch {
      if (error) {
        error.textContent = t("access.revokeError");
        error.hidden = false;
      }
      if (confirm) {
        confirm.disabled = false;
        confirm.textContent = t("access.revoke");
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
              ${this._kind === "contact"
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

  _value() {
    /** @param {string} id */
    const value = (id) =>
      text(/** @type {any} */ (this.querySelector(id))?.value);
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
        key !== "secondLine",
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

/** @param {Record<string, any>} grant @param {boolean} expanded */
function activeGrantView(grant, expanded) {
  return html`<details
    class="site-admin-card site-access-ready"
    data-grant-id="${escapeAttr(grant.grantId)}"
    ${expanded ? "open" : ""}
  >
    <summary>${escapeHtml(grant.label)}</summary>
    <p>
      ${escapeHtml(t("access.expires"))}
      <strong data-grant-countdown
        >${escapeHtml(
          formatCountdown(Date.parse(grant.expiresAt) - Date.now()),
        )}</strong
      >
    </p>
    ${grant.enrollmentUrl
      ? html`<wa-qr-code
            size="220"
            error-correction="M"
            label="${escapeAttr(t("access.qrLabel", { label: grant.label }))}"
          ></wa-qr-code>
          <button class="btn-outline" type="button" data-share-grant>
            ${escapeHtml(t("access.share"))}
          </button>`
      : ""}
    <button class="btn-outline" type="button" data-cancel-staff-grant>
      ${escapeHtml(t("access.cancel"))}
    </button>
  </details>`;
}

/** @param {Element} container @param {string} value */
async function renderEnrollmentQr(container, value) {
  await import("@awesome.me/webawesome/dist/components/qr-code/qr-code.js");
  const qrCode = /** @type {any} */ (container.querySelector("wa-qr-code"));
  if (qrCode?.isConnected) qrCode.value = value;
}

customElements.define("site-admin-view", SiteAdminView);
customElements.define("site-admin-edit", SiteAdminEdit);
customElements.define("site-access-view", SiteAccessView);
