// Address search and manual entry for the Site details and new Site forms.
import { adminApi } from "../../services/admin-api.js";
import { syncSiteDetailsForm } from "../../form-state.js";

/**
 * Each lookup gets its own listeners, since each keeps its own search timer and request.
 * @param {ParentNode} root
 */
export function bindAddressLookup(root) {
  root.querySelectorAll("[data-address-lookup]").forEach((lookup) => {
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

  root.querySelectorAll("[data-edit-address]").forEach((button) => {
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
