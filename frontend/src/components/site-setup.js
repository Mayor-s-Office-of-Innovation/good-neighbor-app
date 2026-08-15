// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR.
/*
  site-setup - code-based login. Staff enter the six-character site code they
  were given; the backend verifies the code is active and returns the provider
  site this shared device should operate as.
*/
import { setSite } from "../db.js";
import { formatSiteCode, validateSetupCode } from "../services/onboarding.js";
import { codeEntryView } from "./site-setup.templates.js";

const CODE_LENGTH = 6;
const INVALID_MESSAGE = "Invalid site code. Check the code and try again.";

class SiteSetup extends HTMLElement {
  connectedCallback() {
    const code = formatSiteCode(readCodeFromUrl());
    this._digits = code.padEnd(CODE_LENGTH, " ").slice(0, CODE_LENGTH).split("");
    this._digits = this._digits.map((digit) => digit.trim());
    this._checking = false;
    this._error = "";
    this._render();
    if (code.length === CODE_LENGTH) {
      this._validate();
    }
  }

  _render(focusIndex = nextEmptyIndex(this._digits)) {
    this.innerHTML = codeEntryView({
      digits: this._digits,
      error: this._error,
      checking: this._checking,
    });

    this.querySelector("#code-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this._validate();
    });

    this.querySelectorAll(".code-box").forEach((input, index) => {
      input.addEventListener("input", (e) => this._onInput(e, index));
      input.addEventListener("keydown", (e) => this._onKeydown(e, index));
      input.addEventListener("paste", (e) => this._onPaste(e, index));
    });

    if (!this._checking) {
      requestAnimationFrame(() => {
        this.querySelector(`#code-${focusIndex}`)?.focus();
      });
    }
  }

  _onInput(event, index) {
    const input = event.currentTarget;
    const value = formatSiteCode(input.value);
    if (!value) {
      this._digits[index] = "";
      this._clearErrorAndRender(index);
      return;
    }
    this._applyCode(value, index);
  }

  _onKeydown(event, index) {
    if (event.key !== "Backspace") return;
    if (this._digits[index]) return;
    if (index <= 0) return;
    event.preventDefault();
    this._digits[index - 1] = "";
    this._clearErrorAndRender(index - 1);
  }

  _onPaste(event, index) {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    this._applyCode(text, index);
  }

  _applyCode(value, startIndex) {
    const chars = formatSiteCode(value).split("");
    const digits = [...this._digits];
    chars.forEach((char, offset) => {
      const target = startIndex + offset;
      if (target < CODE_LENGTH) digits[target] = char;
    });
    this._digits = digits;
    this._error = "";
    this._render(Math.min(startIndex + chars.length, CODE_LENGTH - 1));
  }

  _clearErrorAndRender(focusIndex) {
    this._error = "";
    this._render(focusIndex);
  }

  async _validate() {
    const code = this._digits.join("");
    if (code.length < CODE_LENGTH || this._checking) return;

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
      this._render(CODE_LENGTH - 1);
      return;
    }

    stripCodeFromUrl();
    const providerSite = result.providerSite;
    const site = await setSite(providerSite.name, {
      code: result.code,
      providerSiteId: providerSite.id,
      siteId: providerSite.siteId,
    });
    this.dispatchEvent(
      new CustomEvent("sitebound", { bubbles: true, detail: site }),
    );
  }
}
customElements.define("site-setup", SiteSetup);

/**
 * @param {string[]} digits
 * @returns {number}
 */
function nextEmptyIndex(digits) {
  const index = digits.findIndex((digit) => !digit);
  return index >= 0 ? index : CODE_LENGTH - 1;
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
