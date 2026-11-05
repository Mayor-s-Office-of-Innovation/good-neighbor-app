// AdminApp.bind() adds these again after each render() replaces the HTML.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { asForm, dataAttr } from "../../dom.js";
import { bindSiteProgramCreation } from "./site-program.js";
import { saveWithFeedback } from "../../save-feedback.js";
import {
  controlValue,
  markSiteDetailsSectionEdited,
  reportNamedControlsValidity,
  showFormSaveError,
  syncDirtyForm,
  syncSiteDetailsForm,
} from "../../form-state.js";
import { siteManagerContactDetails } from "./manager.templates.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindSiteRecord(app) {
  const siteDetailsForm = app.querySelector("#site-details-form");
  siteDetailsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = asForm(event.currentTarget);
    if (
      !reportNamedControlsValidity(form, [
        "site-name",
        "public-contact-email",
        "public-contact-phone",
        "public-contact-extension",
      ])
    )
      return;
    app.updateSite(form, "details").catch((error) => {
      app.state.error = error.message;
      app.render();
    });
  });
  app.querySelector("[data-save-address]")?.addEventListener("click", () => {
    if (
      !(siteDetailsForm instanceof HTMLFormElement) ||
      !reportNamedControlsValidity(siteDetailsForm, [
        "street-address",
        "city",
        "state",
        "zip",
      ])
    )
      return;
    app.updateSite(siteDetailsForm, "address").catch((error) => {
      app.state.error = error.message;
      app.render();
    });
  });
  app
    .querySelector("[data-save-lead-program]")
    ?.addEventListener("click", async () => {
      if (
        !reportNamedControlsValidity(siteDetailsForm, [
          "lead-program-id",
          "lead-provider-id",
        ])
      )
        return;
      try {
        const { preview } = await adminApi.reassignSite(
          app.state.site.siteId,
          controlValue(siteDetailsForm, "lead-provider-id"),
          controlValue(siteDetailsForm, "lead-program-id"),
          { preview: true },
        );
        siteDetailsForm.dataset.reassignmentVersion = preview.updatedAt || "";
        const dialog = app.querySelector("#lead-program-confirmation-dialog");
        const providerChanged =
          controlValue(siteDetailsForm, "lead-provider-id") !==
          app.state.site.providerId;
        dialog.querySelector("#lead-program-confirmation-copy").hidden =
          !providerChanged;
        if (providerChanged)
          dialog.setAttribute(
            "aria-describedby",
            "lead-program-confirmation-copy",
          );
        else dialog.removeAttribute("aria-describedby");
        dialog.showModal();
      } catch (error) {
        showFormSaveError(siteDetailsForm, error.message);
      }
    });
  const leadProgramDialog = app.querySelector(
    "#lead-program-confirmation-dialog",
  );
  leadProgramDialog?.addEventListener("close", () => {
    if (
      leadProgramDialog.returnValue !== "confirm" ||
      !(siteDetailsForm instanceof HTMLFormElement) ||
      !reportNamedControlsValidity(siteDetailsForm, ["lead-program-id"])
    )
      return;
    app.updateSite(siteDetailsForm, "lead-program").catch((error) => {
      app.state.error = error.message;
      app.render();
    });
  });
  app
    .querySelector("#site-deliberate-311-form")
    ?.addEventListener("save-feedback-end", (event) =>
      syncDirtyForm(event.currentTarget),
    );
  app
    .querySelector("#site-deliberate-311-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void app.updateSiteDeliberate311(asForm(event.currentTarget));
    });
  if (siteDetailsForm instanceof HTMLFormElement) {
    const sync = (event) => {
      markSiteDetailsSectionEdited(siteDetailsForm, event);
      syncSiteDetailsForm(siteDetailsForm);
    };
    syncSiteDetailsForm(siteDetailsForm, true);
    siteDetailsForm.addEventListener("pointerdown", sync, true);
    siteDetailsForm.addEventListener("keydown", sync, true);
    siteDetailsForm.addEventListener("input", sync);
    siteDetailsForm.addEventListener("change", sync);
    siteDetailsForm.addEventListener("reset", () => queueMicrotask(sync));
  }
  bindSiteProgramCreation(
    app,
    app.state,
    adminApi,
    saveWithFeedback,
    () => {
      if (siteDetailsForm instanceof HTMLFormElement)
        syncSiteDetailsForm(siteDetailsForm);
    },
    actionFeedback,
  );
  app
    .querySelector("wa-select[name='site-manager-user-id']")
    ?.addEventListener("change", (event) => {
      const user = app.state.availableSiteUsers.find(
        (item) => item.userId === event.currentTarget.value,
      );
      const target = app.querySelector("#site-manager-contact-details");
      if (target) target.innerHTML = siteManagerContactDetails(user);
      if (siteDetailsForm instanceof HTMLFormElement)
        syncSiteDetailsForm(siteDetailsForm);
    });
  app.querySelector("#site-perimeter-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    app.updatePerimeter(asForm(e.currentTarget));
  });
  app.querySelector("#reload-site-perimeter")?.addEventListener("click", () => {
    if (app.state.site) app.openSite(app.state.site.siteId, false);
  });
  app.querySelector("#site-details-form")?.addEventListener("input", () => {
    app.state.siteSaveMessage = "";
    app.state.siteSaveError = "";
    app.querySelector("#site-save-status")?.remove();
    app.querySelector("#site-save-error")?.remove();
  });
  app.querySelectorAll("[data-site]").forEach((button) => {
    button.addEventListener("click", () =>
      app.openSite(dataAttr(button, "data-site")),
    );
  });
  const deactivateForm = app.querySelector("#deactivate-site-form");
  const deactivateConfirmation = deactivateForm?.querySelector(
    "[name='confirmation']",
  );
  const deactivateSubmit = deactivateForm?.querySelector(
    "button[type='submit']",
  );
  const confirmedSiteName = () =>
    Boolean(app.state.site?.name) &&
    String(deactivateConfirmation?.value || "") === app.state.site.name;
  const syncDeactivateSubmit = () => {
    if (deactivateSubmit)
      deactivateSubmit.disabled =
        deactivateForm.dataset.saving === "true" || !confirmedSiteName();
  };
  deactivateConfirmation?.addEventListener("input", syncDeactivateSubmit);
  deactivateConfirmation?.addEventListener("change", syncDeactivateSubmit);
  syncDeactivateSubmit();
  deactivateForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      !app.state.capabilities.createEntities ||
      !confirmedSiteName() ||
      deactivateForm.dataset.saving === "true"
    )
      return;
    deactivateForm.dataset.saving = "true";
    syncDeactivateSubmit();
    try {
      await app.deactivateSite(app.state.site.siteId);
    } catch {
      if (deactivateForm.isConnected)
        showFormSaveError(deactivateForm, t("admin.site.deactivateError"));
    } finally {
      delete deactivateForm.dataset.saving;
      if (deactivateForm.isConnected) syncDeactivateSubmit();
    }
  });
}

/** @param {AdminAppElement} app */
export function bindAddressLookup(app) {
  app.querySelectorAll("[data-address-lookup]").forEach((lookup) => {
    const input = lookup.querySelector("[data-address-query]");
    const results = lookup.querySelector("[data-address-results]");
    const status = lookup.querySelector("[data-address-status]");
    const fields = lookup.parentElement?.querySelector("[data-address-fields]");
    const manualButton = lookup.querySelector("[data-enter-address-manually]");
    if (!input || !results || !status || !fields) return;
    let timer;
    let controller;

    const showFields = () => {
      fields.hidden = false;
      fields.setAttribute("data-expanded", "");
      manualButton?.setAttribute("aria-expanded", "true");
      if (manualButton) manualButton.textContent = "Hide manual entry";
      fields.querySelectorAll("wa-input").forEach((field) => {
        field.disabled = false;
      });
      input.removeAttribute("required");
      results.replaceChildren();
      input.setAttribute("aria-expanded", "false");
      const submit = lookup
        .closest("form")
        ?.querySelector("[data-address-dependent]");
      if (submit && !submit.hasAttribute("data-address-blocked")) {
        submit.disabled = false;
      }
    };
    const hideFields = () => {
      fields.hidden = true;
      fields.removeAttribute("data-expanded");
      manualButton?.setAttribute("aria-expanded", "false");
      if (manualButton) manualButton.textContent = "Enter address manually";
      results.replaceChildren();
      input.setAttribute("aria-expanded", "false");
      status.textContent = "Manual address fields hidden.";
    };
    const selectSuggestion = (suggestion) => {
      showFields();
      input.value = suggestion.label;
      const parts = suggestion.addressParts || {};
      const values = {
        "street-address": [parts.streetNumber, parts.streetAddress]
          .filter(Boolean)
          .join(" "),
        city: parts.city || "",
        state: parts.state || "",
        zip: parts.zip || "",
      };
      for (const [name, value] of Object.entries(values)) {
        const field = fields.querySelector(`[name='${name}']`);
        if (!field) continue;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      status.textContent = `${suggestion.label} selected. You can edit the address fields below.`;
      fields.querySelector("[name='street-address']")?.focus();
    };
    const renderSuggestions = (suggestions) => {
      results.replaceChildren();
      for (const suggestion of suggestions) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = suggestion.label;
        button.addEventListener("click", () => selectSuggestion(suggestion));
        item.append(button);
        results.append(item);
      }
      input.setAttribute(
        "aria-expanded",
        suggestions.length ? "true" : "false",
      );
      status.textContent = suggestions.length
        ? `${suggestions.length} address suggestion${suggestions.length === 1 ? "" : "s"} available.`
        : "No matching addresses found. You can enter the address manually.";
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      controller?.abort();
      const query = input.value.trim();
      if (query.length < 3) {
        results.replaceChildren();
        input.setAttribute("aria-expanded", "false");
        status.textContent =
          query.length > 0 ? "Type at least 3 characters." : "";
        return;
      }
      timer = setTimeout(async () => {
        controller = new AbortController();
        status.textContent = "Finding addresses…";
        try {
          const response = await adminApi.suggestAddresses(
            query,
            controller.signal,
          );
          if (query !== input.value.trim()) return;
          renderSuggestions(response.suggestions || []);
        } catch (error) {
          if (error.name === "AbortError") return;
          results.replaceChildren();
          input.setAttribute("aria-expanded", "false");
          status.textContent =
            "Address suggestions are unavailable. Enter the address manually.";
        }
      }, 300);
    });
    input.addEventListener("wa-clear", () => {
      results.replaceChildren();
      input.setAttribute("aria-expanded", "false");
      status.textContent = "";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        const first = results.querySelector("button");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      } else if (event.key === "Escape") {
        results.replaceChildren();
        input.setAttribute("aria-expanded", "false");
      }
    });
    manualButton?.addEventListener("click", () => {
      if (fields.hasAttribute("data-expanded")) {
        hideFields();
      } else {
        showFields();
        fields.querySelector("[name='street-address']")?.focus();
      }
    });
  });

  app.querySelectorAll("[data-edit-address]").forEach((button) => {
    const container = button.closest("[data-address-container]");
    const display = container?.querySelector("[data-address-display]");
    const editor = container?.querySelector("[data-address-editor]");
    const originalValues = new Map(
      [...(editor?.querySelectorAll("[name]") || [])].map((control) => [
        control,
        control.getAttribute("value") ?? String(control.value || ""),
      ]),
    );
    button.addEventListener("click", () => {
      if (!editor) return;
      const isEditing = !editor.hasAttribute("hidden");
      if (isEditing) {
        editor.setAttribute("hidden", "");
        display?.removeAttribute("hidden");
        button.textContent = "Edit address";
        button.setAttribute("aria-expanded", "false");
        for (const [control, value] of originalValues) control.value = value;
        const fields = editor.querySelector("[data-address-fields]");
        fields?.setAttribute("hidden", "");
        fields?.removeAttribute("data-expanded");
        fields?.querySelectorAll("wa-input").forEach((field) => {
          field.disabled = true;
        });
        const manualButton = editor.querySelector(
          "[data-enter-address-manually]",
        );
        if (manualButton) {
          manualButton.textContent = "Enter address manually";
          manualButton.setAttribute("aria-expanded", "false");
        }
        editor.querySelector("[data-address-results]")?.replaceChildren();
        const status = editor.querySelector("[data-address-status]");
        if (status) status.textContent = "";
        const form = button.closest("form");
        if (form instanceof HTMLFormElement) {
          const editedSections = new Set(
            JSON.parse(form.dataset.editedSections || "[]"),
          );
          editedSections.delete("address");
          form.dataset.editedSections = JSON.stringify([...editedSections]);
          syncSiteDetailsForm(form);
        }
        button.focus();
        return;
      }
      display?.setAttribute("hidden", "");
      editor.removeAttribute("hidden");
      button.textContent = "Cancel edit";
      button.setAttribute("aria-expanded", "true");
      editor.querySelector("[data-address-query]")?.focus();
    });
  });
}
