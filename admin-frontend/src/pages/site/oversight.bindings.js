// Site oversight handlers, keyed by the control that starts each one.
import { asForm } from "../../dom.js";
import { siteSaveErrorMessage } from "./save-error-messages.js";
import {
  controlValue,
  setSelectValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";

/**
 * @typedef {import("./site-page.js").SitePageElement} SitePageElement
 * @typedef {import("./record.bindings.js").SiteAction} SiteAction
 */

// The oversight lists end with "Add new…" entries that open a dialog instead.
const OPTION_SELECTS =
  "#site-oversight-form wa-select, #new-city-program-manager-form wa-select[name=manager-department]";

/** @param {Element} select */
function selectValue(select) {
  const form = select.closest("form");
  return form instanceof HTMLFormElement
    ? controlValue(form, select.name)
    : String(select.value || "");
}

/** Remember the real choice, so picking "Add new…" can put it back. @param {SitePageElement} page @param {any} select */
function rememberChoice(page, select) {
  const current = selectValue(select);
  if (!current.startsWith("__add_")) select.dataset.previousValue = current;
}

/** @type {Record<string, Record<string, SiteAction>>} */
export const siteOversightEvents = {
  submit: {
    "#site-oversight-form": (page, form, event) => {
      event.preventDefault();
      page.updateOversight(asForm(form));
    },
    "#new-city-program-manager-form": (page, form, event) => {
      event.preventDefault();
      page
        .createCityProgramManager(asForm(form))
        .catch((error) =>
          showFormSaveError(asForm(form), siteSaveErrorMessage(error)),
        );
    },
    "#new-oversight-option-form": (page, form, event) => {
      event.preventDefault();
      page
        .createOversightOption(asForm(form))
        .catch((error) =>
          showFormSaveError(asForm(form), siteSaveErrorMessage(error)),
        );
    },
  },
  click: {
    "#add-compliance-manager": (page) => {
      const dialog = page.querySelector("#choose-compliance-manager-dialog");
      const search = /** @type {(HTMLElement & { value: string }) | null} */ (
        dialog?.querySelector("#compliance-manager-search") || null
      );
      if (search) search.value = "";
      dialog
        ?.querySelectorAll("[data-select-compliance-manager]")
        .forEach((button) => {
          button.closest("li").hidden = true;
        });
      const resultsHeading = dialog?.querySelector(
        "[data-manager-results-heading]",
      );
      if (resultsHeading) resultsHeading.hidden = true;
      const status = dialog?.querySelector("[data-manager-search-status]");
      if (status)
        status.textContent =
          "Search by name, email, or department to find a program manager.";
      dialog?.showModal();
      search?.focus();
    },
    "#invite-new-compliance-manager": (page) => {
      page.querySelector("#choose-compliance-manager-dialog")?.close();
      const dialog = page.querySelector("#new-city-program-manager-dialog");
      dialog?.showModal();
      dialog?.querySelector("wa-input")?.focus();
    },
    "[data-select-compliance-manager]": (page, button) => {
      const manager = page.state.programManagers.find(
        (item) => item.userId === button.dataset.managerId,
      );
      if (!manager) return;
      page.addComplianceManagerAssignment(manager);
      page.querySelector("#choose-compliance-manager-dialog")?.close();
    },
    "[data-remove-compliance-manager]": (page, button) => {
      button.closest("li[data-manager-id]")?.remove();
      const form = page.querySelector("#site-oversight-form");
      if (form instanceof HTMLFormElement) syncDirtyForm(form);
      page.updateComplianceManagerCount();
    },
    "[data-invite-compliance-manager]": (page, button) => {
      page.inviteExistingComplianceManager(button);
    },
  },
  input: {
    "#compliance-manager-search": (page, input) => {
      const query = String(input.value || "")
        .trim()
        .toLocaleLowerCase("en-US");
      let visible = 0;
      page
        .querySelectorAll("[data-select-compliance-manager]")
        .forEach((button) => {
          const matches =
            Boolean(query) &&
            String(button.dataset.searchText || "").includes(query);
          button.closest("li").hidden = !matches;
          if (matches) visible += 1;
        });
      const resultsHeading = page.querySelector(
        "[data-manager-results-heading]",
      );
      if (resultsHeading) resultsHeading.hidden = !query;
      const status = page.querySelector("[data-manager-search-status]");
      if (status) {
        status.textContent = !query
          ? "Search by name, email, or department to find a program manager."
          : visible
            ? `${visible} program manager${visible === 1 ? "" : "s"} found.`
            : "No matching program managers. You can invite a new one.";
      }
    },
  },
  change: {
    [OPTION_SELECTS]: (page, select) => {
      const value = selectValue(select);
      if (!value.startsWith("__add_")) {
        select.dataset.previousValue = value;
        return;
      }
      const dialogId = {
        __add_department__: "#new-oversight-option-dialog",
        __add_system__: "#new-oversight-option-dialog",
      }[value];
      const dialog = page.querySelector(dialogId);
      if (!dialog) return;
      const form = dialog.querySelector("form");
      const type =
        value === "__add_department__" ? "department" : "systemOfCare";
      const label =
        type === "department" ? "City department" : "System of care";
      form.dataset.targetSelect = select.name;
      form.querySelector("[name='option-type']").value = type;
      form.querySelector("[data-option-title]").textContent =
        `Add a new ${label.toLowerCase()}`;
      form
        .querySelector("[data-option-input]")
        ?.setAttribute("label", `${label} name`);
      setSelectValue(select, select.dataset.previousValue || "");
      dialog.showModal();
      dialog.querySelector("wa-input")?.focus();
    },
  },
  "wa-show": { [OPTION_SELECTS]: rememberChoice },
  focus: { [OPTION_SELECTS]: rememberChoice },
};

/**
 * Show the manager count and limits for the rows just drawn.
 * @param {SitePageElement} page
 */
export function prepareSiteOversight(page) {
  page.updateComplianceManagerCount();
}
