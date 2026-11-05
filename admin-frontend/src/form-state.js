// Save-button and form-reading helpers for the admin forms, so the Site,
// provider and Program forms turn Save on and off the same way.
import { t } from "../../frontend/src/i18n/i18n.js";

/** Enable a form's Save action only while its current values differ from its initial values. */
export function syncDirtyForm(form, initialize = false) {
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
  form.dataset.isDirty = String(
    form.dataset.readOnly !== "true" && snapshot !== form.dataset.initialValues,
  );
  const saveButton = form.querySelector("[data-save-button]");
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled =
      form.dataset.readOnly === "true" ||
      form.dataset.saving === "true" ||
      snapshot === form.dataset.initialValues;
  }
}

/** @param {HTMLFormElement} form */
export function syncProviderDetailsForm(form) {
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
export function syncSiteDetailsForm(form, initialize = false) {
  const sections = {
    details: [
      "site-name",
      "site-type",
      "public-contact-email",
      "public-contact-phone",
      "public-contact-extension",
    ],
    address: ["street-address", "city", "state", "zip"],
    leadProgram: ["lead-program-id", "lead-provider-id"],
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
            : controlValue(form, name),
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
  const isDirty =
    form.dataset.readOnly !== "true" &&
    Object.entries(dirty).some(
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
      control.disabled =
        form.dataset.readOnly === "true" ||
        !dirty[name] ||
        !editedSections.has(name);
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
export function markSiteDetailsSectionEdited(form, event) {
  if (form.dataset.readOnly === "true" || !event.isTrusted) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const name = target.getAttribute("name") || "";
  const section = {
    "site-name": "details",
    "site-type": "details",
    "public-contact-email": "details",
    "public-contact-phone": "details",
    "public-contact-extension": "details",
    "address-query": "address",
    "street-address": "address",
    city: "address",
    state: "address",
    zip: "address",
    "lead-program-id": "leadProgram",
    "lead-provider-id": "leadProgram",
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
export function reportNamedControlsValidity(form, names) {
  return names.every((name) => {
    const control = form.querySelector(`[name='${name}']`);
    return (
      typeof control?.reportValidity !== "function" || control.reportValidity()
    );
  });
}

export function showFormSaveError(form, message) {
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
  error.hidden = false;
  return error;
}

/**
 * Read a Web Awesome or native form control directly. This avoids depending on
 * form-associated custom elements having finished upgrading before submission.
 * @param {HTMLFormElement} form
 * @param {string} name
 */
export function controlValue(form, name) {
  const control = /** @type {{ value?: unknown } | null} */ (
    form.querySelector(`[name='${name}']`)
  );
  if (control instanceof Element && control.localName === "wa-select") {
    const selectedOption = [...control.querySelectorAll("wa-option")].find(
      (option) =>
        option.getAttribute("aria-selected") === "true" ||
        Boolean(/** @type {any} */ (option).selected),
    );
    if (selectedOption) {
      return String(selectedOption.getAttribute("value") ?? "").trim();
    }
  }
  return String(control?.value ?? "").trim();
}

/**
 * Keep a Web Awesome select's host value and option state in sync. This is
 * especially important when restoring the previous choice after an “Add new”
 * directory action.
 * @param {Element & { value?: unknown }} select
 * @param {string} value
 */
export function setSelectValue(select, value) {
  select.querySelectorAll("wa-option").forEach((option) => {
    const selected = option.getAttribute("value") === value;
    /** @type {any} */ (option).selected = selected;
    option.toggleAttribute("selected", selected);
  });
  select.value = value;
}

/** @param {HTMLFormElement} form */
export function selectedComplianceReasons(form) {
  return [...form.querySelectorAll("wa-checkbox[name='terms-reason']")]
    .filter((checkbox) => /** @type {any} */ (checkbox).checked)
    .map((checkbox) => String(/** @type {any} */ (checkbox).value));
}

/** @param {HTMLFormElement} form */
export function compliancePeriodValidationError(form) {
  const reasons = selectedComplianceReasons(form);
  if (!reasons.length)
    return "Select at least one reason for requiring perimeter checks.";
  if (
    reasons.some((reason) => ["1", "6"].includes(reason)) &&
    !controlValue(form, "terms-expiry")
  ) {
    return "Enter the last day checks are required for the selected reasons.";
  }
  const checksPerDay = Number(controlValue(form, "terms-checks-per-day"));
  if (!Number.isInteger(checksPerDay) || checksPerDay < 1 || checksPerDay > 8) {
    return t("admin.compliance.invalidCadence");
  }
  return "";
}

/** @param {Record<string, unknown>} values */
export function hasEnteredValues(values) {
  return Object.values(values).some((value) => String(value || "").trim());
}

/** @param {FormData} data @param {string} name */
export function formValue(data, name) {
  return String(data.get(name) || "").trim();
}
