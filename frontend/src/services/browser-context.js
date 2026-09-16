/*
  browser-context.js — detect in-app browser webviews and help users escape.

  Field demos keep hitting this: someone opens the app from a link inside
  email/social apps and lands in that app's embedded webview, where the
  file-input camera intent ("Take photo") silently does nothing and site
  re-entry codes can behave oddly. We can't fix a webview from inside it, but
  we can detect the common ones and hand the user to the real browser:

  - iOS: any `target="_blank"` link opens in Safari from every known webview.
  - Android WebView: `target="_blank"` often stays trapped, so we hand off an
    `intent://` URL whose `S.browser_fallback_url` opens the default browser.

  Detection is user-agent sniffing, so it's "warn on known-bad agents," never a
  hard block — the caller's copy should say "may not open," not "won't."
*/

const IOS_WEBVIEW_PATTERNS = [
  /FBIOS/, // Facebook
  /FBAV/, // Facebook app (some builds)
  /Instagram/,
  /TwitterApp/, // X (Twitter)
  /LinkedInApp/,
  /Outlook-iOS/,
  /GmailApp/,
  /HeyEmail/, // Gmail (older builds)
  /Snapchat/,
  /Line\//,
  /ThreadsApp/,
];

// Real iOS browsers that present as Safari-like but support the camera intent.
const IOS_BROWSER_EXCEPTIONS = /CriOS|FxiOS|EdgiOS|OPT\/|DuckDuckGo|BraveiOS/;

const ANDROID_WEBVIEW_PATTERN = /(?:; wv\)|FB_IAB|FBAN)/;

/** @returns {boolean} this UA is a known in-app webview (iOS or Android). */
export function isInAppBrowser(
  ua = typeof navigator !== "undefined" ? navigator.userAgent : "",
) {
  if (typeof ua !== "string" || !ua) return false;
  if (ANDROID_WEBVIEW_PATTERN.test(ua)) return true;
  // iOS webviews are all Safari-clone UAs; vendor tokens are the discriminator.
  if (!/iPhone|iPad|iPod/.test(ua)) return false;
  if (IOS_BROWSER_EXCEPTIONS.test(ua)) return false;
  return IOS_WEBVIEW_PATTERNS.some((pattern) => pattern.test(ua));
}

/**
 * The current page URL to hand off to the real browser, with a `code` param
 * preserved so onboarding can continue after the jump (site-setup reads it).
 * @returns {string}
 */
export function handoffUrl() {
  return typeof location !== "undefined" ? location.href : "";
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
