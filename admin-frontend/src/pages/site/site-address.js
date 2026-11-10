// Address fields for both the new Site flow and the Site details editor, so
// both save the same street, city, state and ZIP parts.
import { escapeHtml } from "../../dom.js";
import { formValue } from "../../form-state.js";

export function parseLegacyAddress(value) {
  const match =
    /^\s*([^,]+),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/.exec(
      String(value || ""),
    );
  if (!match) return null;
  const street = /^(\S+)\s+(.+)$/.exec(match[1].trim());
  if (!street) return null;
  return {
    streetNumber: street[1],
    streetAddress: street[2],
    secondLine: "",
    city: match[2].trim(),
    state: match[3].toUpperCase(),
    zip: match[4],
  };
}

export function addressEditor(address, options = {}) {
  const required = Boolean(options.required);
  const line = streetLineFromParts(address);
  const formatted = formatAddressParts(address);
  return `<div class="address-editor">
    <div class="address-lookup" data-address-lookup>
      <wa-input class="address-search" type="search" pill with-clear label="Search for an address" name="address-query" value="${escapeHtml(formatted)}" placeholder="Start typing a street address" autocomplete="off" inputmode="search" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="address-suggestions" data-address-query ${required ? "required data-empty" : ""}>
        <wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon>
      </wa-input>
      <ul class="address-suggestions" id="address-suggestions" data-address-results></ul>
      <p class="visually-hidden" aria-live="polite" data-address-status></p>
      <button class="btn-neutral-filled address-manual" type="button" aria-controls="manual-address-fields" aria-expanded="false" data-enter-address-manually>Enter address manually</button>
      <p class="field-help">Address suggestions powered by <a href="https://photon.komoot.io/" target="_blank" rel="noopener noreferrer">Photon</a> and © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>.</p>
    </div>
    <div class="form-grid form-grid--one address-fields" id="manual-address-fields" data-address-fields hidden>
      ${addressField("street-address", "Street address", line, { autocomplete: "street-address", required, disabled: true })}
      ${addressField("city", "City", address.city || "", { autocomplete: "address-level2", required, disabled: true })}
      ${addressField("state", "State", address.state || "", { autocomplete: "address-level1", maxlength: 2, required, disabled: true })}
      ${addressField("zip", "ZIP", address.zip || "", { autocomplete: "postal-code", pattern: "[0-9]{5}(-[0-9]{4})?", required, disabled: true })}
    </div>
  </div>`;
}

/**
 * @param {string} name
 * @param {string} label
 * @param {unknown} value
 * @param {{ autocomplete?: string, pattern?: string, maxlength?: number, required?: boolean, disabled?: boolean }} [options]
 */
function addressField(name, label, value, options = {}) {
  const required = Boolean(options.required);
  return `<wa-input class="${required ? "required-flow-field" : ""}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : ""} ${options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : ""} ${options.maxlength ? `maxlength="${escapeHtml(options.maxlength)}"` : ""} ${required ? "required data-empty" : "required"} ${options.disabled ? "disabled" : ""}><span slot="label">${escapeHtml(label)}${required ? " <em>Required</em>" : ""}</span></wa-input>`;
}

export function addressPartsFromForm(data) {
  const streetLine = formValue(data, "street-address");
  const match = /^(\S+)\s+(.+)$/.exec(streetLine);
  return {
    streetNumber: match?.[1] || "",
    streetAddress: match?.[2] || "",
    secondLine: "",
    city: formValue(data, "city"),
    state: formValue(data, "state").toUpperCase(),
    zip: formValue(data, "zip"),
  };
}

export function streetLineFromParts(address) {
  return [address.streetNumber, address.streetAddress, address.secondLine]
    .filter(Boolean)
    .join(" ");
}

export function formatAddressParts(address) {
  const street = streetLineFromParts(address);
  const region = [address.state, address.zip].filter(Boolean).join(" ");
  const locality = [address.city, region].filter(Boolean).join(", ");
  return [street, locality].filter(Boolean).join(", ");
}

/**
 * @param {{ latitude?: number, longitude?: number } | undefined} location
 * @returns {location is { latitude: number, longitude: number }}
 */
export function hasSiteCoordinates(location) {
  return (
    typeof location?.latitude === "number" &&
    typeof location.longitude === "number"
  );
}
