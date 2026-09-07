// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR.
/*
  site-setup - code-based login. Staff enter the six-character site code they
  were given; the backend verifies the code is active and returns the provider
  site this shared device should operate as.
*/
import { setSite } from "../db.js";
import { formatSiteCode, validateSetupCode } from "../services/onboarding.js";
import { registerDevice } from "../services/devices.js";
import { codeEntryView } from "./site-setup.templates.js";

const CODE_LENGTH = 6;
const INVALID_MESSAGE = "Invalid site code. Check the code and try again.";

class SiteSetup extends HTMLElement {
  connectedCallback() {
    this._code = formatSiteCode(readCodeFromUrl());
    this._checking = false;
    this._error = "";
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
    });

    this._form = this.querySelector("#code-form");
    this._otp = this.querySelector("#code-input");
    this._continue = this.querySelector("#continue");

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
customElements.define("site-setup", SiteSetup);

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
