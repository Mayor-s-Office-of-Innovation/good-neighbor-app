/*
  location-dialog — "Is your app set to the right location?" A native modal
  shown by today-view before a check starts when the device's position is
  outside the bound site's radius.

  Presentational plus one piece of local state: the highlighted site. The host
  owns the site catalog and the actual switch. It creates one instance, pushes
  siteName / sites / currentSite before each render, swaps it in for the
  <location-dialog> placeholder in the home shell, and calls open(prompt) —
  `prompt` is an opaque value handed back on every event so the host knows
  which capture flow was waiting. Events (all bubble):
    "locationconfirm"  detail { siteId, prompt }        — switch to a different site
    "locationstay"     detail { prompt }                 — carry on at this site
    "locationclosed"   detail { changingSite, prompt }   — dialog closed, any reason
  Order on Stay: the dialog closes (locationclosed) before locationstay fires,
  matching the original inline handler.
*/
import "./location-dialog.css";
import {
  locationDialog,
  locationDialogSites,
} from "./location-dialog.templates.js";

class LocationDialog extends HTMLElement {
  constructor() {
    super();
    /** @type {string} */
    this.siteName = "";
    /** @type {Array<{ siteId: string, name: string }>} */
    this.sites = [];
    /** @type {{ siteId: string, name: string }} */
    this.currentSite = { siteId: "", name: "" };
    this._selectedSiteId = "";
    this._prompt = null;
  }

  connectedCallback() {
    this.render();
  }

  /** @returns {string} the highlighted site (the bound site until changed) */
  get selectedSiteId() {
    return this._selectedSiteId || this.currentSite.siteId;
  }

  /**
   * Show the prompt with the bound site highlighted and focused.
   * @param {unknown} [prompt] handed back on every event
   */
  open(prompt = null) {
    this._prompt = prompt;
    this._selectedSiteId = this.currentSite.siteId;
    this.render();
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#location-dialog")
    );
    dialog?.showModal();
    /** @type {HTMLButtonElement | null} */ (
      dialog?.querySelector('.location-dialog__site[aria-pressed="true"]') ||
        null
    )?.focus();
  }

  render() {
    this.innerHTML = locationDialog({
      siteName: this.siteName,
      sites: locationDialogSites(this.sites, this.currentSite),
      currentSiteId: this.selectedSiteId,
    });
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#location-dialog")
    );
    if (!dialog) return;
    dialog.addEventListener("close", () => {
      this.dispatchEvent(
        new CustomEvent("locationclosed", {
          bubbles: true,
          detail: {
            changingSite: this.selectedSiteId !== this.currentSite.siteId,
            prompt: this._prompt,
          },
        }),
      );
    });
    // Selecting a site updates the pressed state in place (no re-render, so
    // focus stays where the user put it) and unlocks Confirm.
    dialog.querySelectorAll("[data-location-site]").forEach((button) => {
      button.addEventListener("click", () => {
        this._selectedSiteId =
          button.getAttribute("data-location-site") || this.currentSite.siteId;
        dialog.querySelectorAll("[data-location-site]").forEach((option) => {
          const selected =
            option.getAttribute("data-location-site") === this.selectedSiteId;
          option.setAttribute("aria-pressed", String(selected));
          const check = option.querySelector(".home-site-switcher__check");
          if (check) check.textContent = selected ? "✓" : "";
        });
        const confirm = /** @type {HTMLButtonElement | null} */ (
          dialog.querySelector("#location-confirm")
        );
        if (confirm) {
          confirm.disabled = this.selectedSiteId === this.currentSite.siteId;
        }
      });
    });
    dialog.querySelector("#location-confirm")?.addEventListener("click", () => {
      if (this.selectedSiteId === this.currentSite.siteId) return;
      dialog.close();
      this.dispatchEvent(
        new CustomEvent("locationconfirm", {
          bubbles: true,
          detail: { siteId: this.selectedSiteId, prompt: this._prompt },
        }),
      );
    });
    dialog.querySelector("#location-stay")?.addEventListener("click", () => {
      const prompt = this._prompt;
      dialog.close();
      this.dispatchEvent(
        new CustomEvent("locationstay", { bubbles: true, detail: { prompt } }),
      );
    });
  }
}

customElements.define("location-dialog", LocationDialog);
