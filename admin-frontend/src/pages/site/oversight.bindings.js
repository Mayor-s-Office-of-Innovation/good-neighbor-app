// AdminApp.bind() adds these again after each render() replaces the HTML.
import { asForm } from "../../dom.js";
import {
  controlValue,
  setSelectValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindSiteOversight(app) {
  app.querySelector("#site-oversight-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    app.updateOversight(asForm(e.currentTarget));
  });
  app
    .querySelector("#add-compliance-manager")
    ?.addEventListener("click", () => {
      const dialog = app.querySelector("#choose-compliance-manager-dialog");
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
    });
  bindComplianceManagerAssignmentControls(app);
  app.updateComplianceManagerCount();
  app
    .querySelector("#invite-new-compliance-manager")
    ?.addEventListener("click", () => {
      app.querySelector("#choose-compliance-manager-dialog")?.close();
      const dialog = app.querySelector("#new-city-program-manager-dialog");
      dialog?.showModal();
      dialog?.querySelector("wa-input")?.focus();
    });
  app.querySelectorAll("[data-select-compliance-manager]").forEach((button) => {
    button.addEventListener("click", () => {
      const manager = app.state.programManagers.find(
        (item) => item.userId === button.dataset.managerId,
      );
      if (!manager) return;
      app.addComplianceManagerAssignment(manager);
      app.querySelector("#choose-compliance-manager-dialog")?.close();
    });
  });
  app
    .querySelector("#compliance-manager-search")
    ?.addEventListener("input", (event) => {
      const query = String(event.currentTarget.value || "")
        .trim()
        .toLocaleLowerCase("en-US");
      let visible = 0;
      app
        .querySelectorAll("[data-select-compliance-manager]")
        .forEach((button) => {
          const matches =
            Boolean(query) &&
            String(button.dataset.searchText || "").includes(query);
          button.closest("li").hidden = !matches;
          if (matches) visible += 1;
        });
      const resultsHeading = app.querySelector(
        "[data-manager-results-heading]",
      );
      if (resultsHeading) resultsHeading.hidden = !query;
      const status = app.querySelector("[data-manager-search-status]");
      if (status) {
        status.textContent = !query
          ? "Search by name, email, or department to find a program manager."
          : visible
            ? `${visible} program manager${visible === 1 ? "" : "s"} found.`
            : "No matching program managers. You can invite a new one.";
      }
    });
  app
    .querySelectorAll(
      "#site-oversight-form wa-select, #new-city-program-manager-form wa-select[name=manager-department]",
    )
    .forEach((select) => {
      select.addEventListener("change", async () => {
        const oversightForm = select.closest("form");
        const value =
          oversightForm instanceof HTMLFormElement
            ? controlValue(oversightForm, select.name)
            : String(select.value || "");
        if (!value.startsWith("__add_")) {
          select.dataset.previousValue = value;
          return;
        }
        const dialogId = {
          __add_department__: "#new-oversight-option-dialog",
          __add_system__: "#new-oversight-option-dialog",
        }[value];
        const dialog = app.querySelector(dialogId);
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
      });
      select.addEventListener("wa-show", () => {
        const oversightForm = select.closest("form");
        const current =
          oversightForm instanceof HTMLFormElement
            ? controlValue(oversightForm, select.name)
            : String(select.value || "");
        if (!current.startsWith("__add_"))
          select.dataset.previousValue = current;
      });
      select.addEventListener("focus", () => {
        const oversightForm = select.closest("form");
        const current =
          oversightForm instanceof HTMLFormElement
            ? controlValue(oversightForm, select.name)
            : String(select.value || "");
        if (!current.startsWith("__add_"))
          select.dataset.previousValue = current;
      });
    });
  app
    .querySelector("#new-city-program-manager-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app
        .createCityProgramManager(asForm(event.currentTarget))
        .catch((error) =>
          showFormSaveError(asForm(event.currentTarget), error.message),
        );
    });
  app
    .querySelector("#new-oversight-option-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app
        .createOversightOption(asForm(event.currentTarget))
        .catch((error) =>
          showFormSaveError(asForm(event.currentTarget), error.message),
        );
    });
}

/** @param {AdminAppElement} app */
export function bindComplianceManagerAssignmentControls(app) {
  app.querySelectorAll("[data-remove-compliance-manager]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      button.closest("li[data-manager-id]")?.remove();
      const form = app.querySelector("#site-oversight-form");
      if (form instanceof HTMLFormElement) syncDirtyForm(form);
      app.updateComplianceManagerCount();
    });
  });
  app.querySelectorAll("[data-invite-compliance-manager]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      app.inviteExistingComplianceManager(button);
    });
  });
}
