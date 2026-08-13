// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  site-setup — first-run onboarding. Instead of picking a location, the staffer
  arrives from an emailed link that carries a setup code tied to their site
  (…/?code=HCM-4820), or types that code in. We validate the code against the
  (mocked) backend, confirm the resolved site, then bind the device to it. No
  login — the code is the identity check.

  States: checking → confirm  (happy path, code present in URL)
          code-entry → checking → confirm  (typed code)
  A "Don't have a code?" disclosure keeps a manual site picker as a fallback so
  setup is never a dead end (prototype convenience).

  Markup lives in site-setup.templates.js; this file is logic + event wiring only.
  Dispatches 'sitebound' once the device is bound so app-root can render the app.
*/
import { setSite } from "../db.js";
import { validateSetupCode } from "../services/onboarding.js";
import {
  checkingView,
  confirmView,
  codeEntryView,
} from "./site-setup.templates.js";

// Fallback manual site list — only surfaced behind the "Don't have a code?"
// disclosure. In a later phase the real list comes from the backend.
const SITES = [
  "City Hall",
  "Main Library",
  "Public Works HQ",
  "Health Center — Mission",
  "Transit Center",
  "Community Center — Bayview",
];

class SiteSetup extends HTMLElement {
  connectedCallback() {
    const code = readCodeFromUrl();
    if (code) this._validate(code);
    else this._renderCodeEntry();
  }

  _renderChecking() {
    this.innerHTML = checkingView();
  }

  async _validate(code) {
    this._renderChecking();
    let res;
    try {
      res = await validateSetupCode(code);
    } catch {
      res = { ok: false, reason: "network" };
    }
    if (res.ok) {
      this._pending = res;
      this._renderConfirm();
    } else {
      this._renderCodeEntry({
        value: code,
        error:
          res.reason === "empty"
            ? "Enter the setup code from your email."
            : "We couldn’t reach the server. Check your connection and try again.",
      });
    }
  }

  _renderConfirm() {
    const { site, code } = this._pending;
    this.innerHTML = confirmView({ site, code });
    this.querySelector("#confirm").addEventListener("click", () =>
      this._bind(site, { code }),
    );
    this.querySelector("#use-code").addEventListener("click", () =>
      this._renderCodeEntry(),
    );
  }

  _renderCodeEntry(opts = {}) {
    this.innerHTML = codeEntryView({ ...opts, sites: SITES });
    const form = this.querySelector("#code-form");
    const input = this.querySelector("#code");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._validate(input.value);
    });
    this.querySelector("#manual-bind").addEventListener("click", () => {
      this._bind(this.querySelector("#site-select").value, {});
    });
    requestAnimationFrame(() => input.focus());
  }

  async _bind(name, meta) {
    stripCodeFromUrl(); // don't leave the one-time code sitting in the address bar
    const site = await setSite(name, meta);
    this.dispatchEvent(
      new CustomEvent("sitebound", { bubbles: true, detail: site }),
    );
  }
}
customElements.define("site-setup", SiteSetup);

// Read the setup code from the emailed link. Supports ?code=… as well as the
// hash forms (#…?code=… / #code=…) so it works under hash-based routing too.
function readCodeFromUrl() {
  const fromSearch = new URLSearchParams(location.search).get("code");
  if (fromSearch) return fromSearch.trim();
  const hash = location.hash.replace(/^#/, "");
  const q = hash.indexOf("?");
  if (q >= 0) {
    const c = new URLSearchParams(hash.slice(q + 1)).get("code");
    if (c) return c.trim();
  }
  const m = hash.match(/(?:^|&)code=([^&]+)/);
  return m ? decodeURIComponent(m[1]).trim() : "";
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
