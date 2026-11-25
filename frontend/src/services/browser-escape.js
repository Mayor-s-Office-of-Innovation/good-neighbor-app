// Only the lazy-loaded webview warning needs URL handoff construction. Keep
// this separate from browser detection, which is part of normal app startup.

import { pendingSetupCode } from "./pending-setup-code.js";

/**
 * The current page URL to hand off to the real browser, with the setup code
 * preserved so onboarding can continue after the jump (site-setup reads it).
 * Setup removes the code from the address bar, so it is added back here as a
 * `#code=` fragment (never sent to a server) when the URL no longer has it.
 * @returns {string}
 */
export function handoffUrl() {
  if (typeof location === "undefined") return "";
  const code = pendingSetupCode();
  if (!code) return location.href;
  try {
    const url = new URL(location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (!url.searchParams.has("code") && !fragment.has("code")) {
      fragment.set("code", code);
      url.hash = fragment.toString();
    }
    return url.toString();
  } catch {
    return location.href;
  }
}

/**
 * Escape URL for the current context: plain https on iOS, an intent:// URL on
 * Android. The caller must invoke from a user gesture (a tap) for popups to
 * be allowed.
 *
 * Android intent URIs are authority-form (`intent://<host>/<path>#Intent;...`),
 * not `intent:<full-url>` — an inline `://` after `intent:` would itself be
 * parsed as the URI's authority/delimiter territory, and any `#` in the page
 * URL would terminate the target URI before the metadata block. So the page
 * URL rides ONLY in `S.browser_fallback_url` (fully percent-encoded, `#`
 * included), with a bare host/path target declared via `scheme=https`.
 * @param {string} ua
 * @returns {string}
 */
export function escapeUrlForPlatform(
  ua = typeof navigator !== "undefined" ? navigator.userAgent : "",
) {
  const target = handoffUrl();
  if (!target) return target;
  if (/Android/.test(ua)) {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return target;
    }
    const hostPath = `${parsed.host}${parsed.pathname}${parsed.search}`;
    const fallback = encodeURIComponent(target);
    return `intent://${hostPath}#Intent;scheme=${parsed.protocol.replace(":", "")};S.browser_fallback_url=${fallback};end`;
  }
  return target;
}
