// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR.
/*
  site-setup - code-based login. Staff enter the six-character site code they
  were given; the backend verifies the code is active and returns the provider
  site this shared device should operate as.
*/
import { setSite } from "../db.js";
import {
  formatSiteCode,
  requestSetupCode,
  searchSites,
  validateSetupCode,
} from "../services/onboarding.js";
import { registerDevice } from "../services/devices.js";
import { codeEntryView } from "./site-setup.templates.js";

const CODE_LENGTH = 6;
const INVALID_MESSAGE = "Invalid site code. Check the code and try again.";
const SITE_SEARCH_DELAY_MS = 250;

class SiteSetup extends HTMLElement {
  connectedCallback() {
    this._code = formatSiteCode(readCodeFromUrl());
    this._checking = false;
    this._error = "";
    this._mode = "code";
    this._request = {
      query: "",
      email: "",
      searching: false,
      requesting: false,
      sites: [],
      selectedSiteId: "",
      message: "",
      error: "",
    };
    this._siteSearchTimer = null;
    this._siteSearchGeneration = 0;
    this._render();
    if (this._code.length === CODE_LENGTH) {
      this._validate();
    }
  }

  _render() {
    this.innerHTML = codeEntryView({
      value: this._code,
      error: this._error,
      checking: this._checking,
      mode: this._mode,
      request: this._request,
    });

    if (this._mode === "request") {
      this._bindRequestForm();
      return;
    }

    this._form = this.querySelector("#code-form");
    this._otp = this.querySelector("#code-input");
    this._continue = this.querySelector("#continue");
    this.querySelector("#show-request-code")?.addEventListener("click", () => {
      this._mode = "request";
      this._error = "";
      this._render();
    });

    this._form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._validate();
    });

    // <wa-otp-input> owns per-segment typing, arrow-key nav, backspace, and
    // paste internally — we only react to the resulting value. `wa-complete`
    // fires once all six segments are filled.
    this._otp.addEventListener("input", () => this._onInput());
    this._otp.addEventListener("wa-complete", () => this._onInput());

    if (!this._checking) {
      requestAnimationFrame(() => this._otp?.focus());
    }
  }

  _bindRequestForm() {
    const form = this.querySelector("#request-code-form");
    form?.addEventListener("input", () => this._syncRequestSubmit());
    form?.addEventListener("change", () => this._syncRequestSubmit());
    this.querySelector("#show-code-entry")?.addEventListener("click", () => {
      this._cancelSiteSearch();
      this._mode = "code";
      this._render();
    });
    this.querySelector("#site-search")?.addEventListener("input", (e) => {
      this._request.query = e.target.value;
      if (e.target instanceof HTMLInputElement) {
        const end = e.target.value.length;
        e.target.setSelectionRange(end, end);
      }
      this._request.selectedSiteId = "";
      this._request.message = "";
      this._request.error = "";
      this._syncRequestSubmit();
      this._queueSiteSearch();
    });
    this.querySelector("#work-email")?.addEventListener("input", (e) => {
      this._request.email = e.target.value;
      this._request.message = "";
      this._request.error = "";
      this._syncRequestSubmit();
    });
    this.querySelectorAll(".login__result").forEach((button) => {
      button.addEventListener("click", () => {
        const siteId = button.getAttribute("data-site-id") || "";
        const site = this._request.sites.find((s) => s.siteId === siteId);
        this._request.selectedSiteId = siteId;
        this._request.query = site?.label || site?.name || this._request.query;
        this._render();
      });
    });
    this.querySelector("#request-code-form")?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this._requestCode();
      },
    );
    this._syncRequestSubmit();
  }

  // Keep the button and error state in sync without re-rendering (which would
  // recreate the field and drop focus mid-entry).
  _onInput() {
    this._code = formatSiteCode(this._otp.value);
    if (this._error) {
      this._error = "";
      this._otp.classList.remove("login__otp--error");
      this._form?.classList.remove("login__form--error");
      const errorEl = this.querySelector("#code-error");
      if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }
    }
    if (this._continue) {
      this._continue.disabled = this._code.length < CODE_LENGTH;
    }
  }

  _queueSiteSearch() {
    const query = this._request.query;
    clearTimeout(this._siteSearchTimer);
    if (query.trim().length < 2) {
      this._siteSearchGeneration += 1;
      const hadSearchUi =
        this._request.searching ||
        this._request.sites.length > 0 ||
        this._request.error;
      this._request.sites = [];
      this._request.searching = false;
      if (hadSearchUi) {
        this._renderRequestPreservingFocus();
      }
      return;
    }
    const generation = this._siteSearchGeneration + 1;
    this._siteSearchGeneration = generation;
    this._request.searching = true;
    this._syncRequestStatus();
    this._siteSearchTimer = setTimeout(() => {
      this._searchSites(query, generation);
    }, SITE_SEARCH_DELAY_MS);
  }

  async _searchSites(
    query = this._request.query,
    generation = this._siteSearchGeneration,
  ) {
    const result = await searchSites(query);
    if (
      this._mode !== "request" ||
      this._siteSearchGeneration !== generation ||
      this._request.query !== query
    ) {
      return;
    }
    this._request.searching = false;
    this._request.sites = result.ok ? result.sites : [];
    this._request.error = result.ok
      ? ""
      : "We couldn't search sites. Try again in a moment.";
    this._renderRequestPreservingFocus();
  }

  _cancelSiteSearch() {
    clearTimeout(this._siteSearchTimer);
    this._siteSearchTimer = null;
    this._siteSearchGeneration += 1;
    this._request.searching = false;
  }

  _renderRequestPreservingFocus() {
    const active = document.activeElement;
    const shouldRestore =
      active instanceof HTMLInputElement &&
      this.contains(active) &&
      (active.id === "site-search" || active.id === "work-email");
    const activeId = shouldRestore ? active.id : "";
    const selectionStart = shouldRestore ? active.selectionStart : null;
    const selectionEnd = shouldRestore ? active.selectionEnd : null;
    this._preserveRequestFocus = shouldRestore;
    this._render();
    this._preserveRequestFocus = false;
    if (shouldRestore) {
      requestAnimationFrame(() => {
        const input = this.querySelector(`#${activeId}`);
        input?.focus();
        if (
          input instanceof HTMLInputElement &&
          selectionStart !== null &&
          selectionEnd !== null
        ) {
          input.setSelectionRange(selectionStart, selectionEnd);
        }
      });
    }
  }

  _syncRequestStatus() {
    const hint = this.querySelector(".login__hint");
    if (hint) {
      hint.hidden = !this._request.searching;
    }
  }

  _syncRequestSubmit() {
    const submit = this.querySelector("#request-code-submit");
    const emailInput = this.querySelector("#work-email");
    if (emailInput) {
      this._request.email = emailInput.value;
    }
    if (submit) {
      submit.disabled =
        this._request.requesting ||
        !this._request.selectedSiteId ||
        !this._request.email.trim();
    }
  }

  async _requestCode() {
    if (this._request.requesting) return;
    this._syncRequestSubmit();
    if (!this._request.selectedSiteId || !this._request.email.trim()) return;
    this._request.requesting = true;
    this._request.error = "";
    this._request.message = "";
    this._render();
    const result = await requestSetupCode({
      siteId: this._request.selectedSiteId,
      email: this._request.email,
    });
    this._request.requesting = false;
    if (result.ok) {
      this._request.message = result.message;
    } else {
      this._request.error =
        result.reason === "invalid"
          ? "Choose a site and enter a work email."
          : "We couldn't request a code. Try again in a moment.";
    }
    this._render();
  }

  async _validate() {
    const code = formatSiteCode(this._otp ? this._otp.value : this._code);
    if (code.length < CODE_LENGTH || this._checking) return;
    this._code = code;

    this._checking = true;
    this._error = "";
    this._render();

    const result = await validateSetupCode(code);
    if (!result.ok) {
      this._checking = false;
      this._error =
        result.reason === "network"
          ? "We couldn't check the code. Try again in a moment."
          : INVALID_MESSAGE;
      this._render();
      return;
    }

    stripCodeFromUrl();
    const providerSite = result.providerSite;
    // Register the device and mint its session (Option 4 device auth —
    // docs/adr/0010): the token rides the site record; after this point the
    // setup code is never needed again (the refresh flow renews silently).
    let session;
    try {
      session = await registerDevice(result.code);
    } catch (err) {
      if (err instanceof Error && /invalid site code/.test(err.message)) {
        this._checking = false;
        this._error = INVALID_MESSAGE;
        this._render();
        return;
      }
      this._checking = false;
      this._error = "We couldn't set up this device. Try again in a moment.";
      this._render();
      return;
    }
    const site = await setSite(providerSite.name, {
      code: result.code,
      providerSiteId: providerSite.id,
      siteId: providerSite.siteId,
      deviceId: session.deviceId,
      token: session.token,
      refreshToken: session.refreshToken,
      tokenExpiresAt: new Date(
        Date.now() + session.expiresIn * 1000,
      ).toISOString(),
      tokenGeneration: session.tokenGeneration,
    });
    this.dispatchEvent(
      new CustomEvent("sitebound", { bubbles: true, detail: site }),
    );
  }
}

if (!customElements.get("site-setup")) {
  customElements.define("site-setup", SiteSetup);
} else if (import.meta.hot) {
  location.reload();
}

if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
}

function readCodeFromUrl() {
  const fromSearch = new URLSearchParams(location.search).get("code");
  return fromSearch ? fromSearch.trim() : "";
}

function stripCodeFromUrl() {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("code")) {
      url.searchParams.delete("code");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  } catch {
    /* no-op */
  }
}
