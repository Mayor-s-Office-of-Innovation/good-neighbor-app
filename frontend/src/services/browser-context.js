/*
  browser-context.js — detect in-app browser webviews and help users escape.

  Field demos keep hitting this: someone opens the app from a link inside
  email/social apps and lands in that app's embedded webview, where the
  file-input camera intent ("Take photo") silently does nothing and site
  re-entry codes can behave oddly. We can't fix a webview from inside it, but
  we can detect the common ones and hand the user to the real browser:

  New windows and Android intents are best-effort only: the host app controls
  navigation. The dismissible banner offers an external-browser attempt, not
  a guaranteed escape from the host app.

  Detection is conservative user-agent sniffing. Recognized webviews receive
  a warning and do not get PWA install offers; access itself is not blocked.
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
