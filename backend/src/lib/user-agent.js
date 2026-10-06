/*
 * Minimal user-agent parser for the client-events forwarder. Server-side
 * PostHog events carry no browser/OS/device properties unless we set them,
 * and the field question this pipeline exists to answer ("which old Android
 * devices and browsers misbehave?") needs exactly those. Deliberately small:
 * the browsers field devices actually run, nothing more. Unknowns are left
 * as "Unknown" rather than guessed.
 */

/**
 * @typedef {object} ParsedUserAgent
 * @property {string} browser
 * @property {string} browserVersion
 * @property {string} os
 * @property {string} osVersion
 * @property {"Mobile" | "Tablet" | "Desktop"} deviceType
 * @property {boolean} webview true for an Android WebView (`; wv)`)
 */

/**
 * @param {string} ua
 * @param {RegExp} re with one capture group for the version
 * @returns {string}
 */
function version(ua, re) {
  const m = ua.match(re);
  return m?.[1] ? m[1].replace(/_/g, ".") : "";
}

/**
 * @param {unknown} ua
 * @returns {ParsedUserAgent}
 */
export function parseUserAgent(ua) {
  const s = typeof ua === "string" ? ua : "";
  const isIos = /iPhone|iPad|iPod/.test(s);
  const isAndroid = /Android/.test(s);

  let os = "Unknown";
  let osVersion = "";
  if (isIos) {
    os = "iOS";
    osVersion = version(s, /OS (\d+[_.]\d+(?:[_.]\d+)?)/);
  } else if (isAndroid) {
    os = "Android";
    osVersion = version(s, /Android (\d+(?:\.\d+)*)/);
  } else if (/Windows NT/.test(s)) {
    os = "Windows";
    osVersion = version(s, /Windows NT (\d+(?:\.\d+)*)/);
  } else if (/CrOS/.test(s)) {
    os = "Chrome OS";
  } else if (/Mac OS X/.test(s)) {
    os = "Mac OS X";
    osVersion = version(s, /Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/);
  } else if (/Linux/.test(s)) {
    os = "Linux";
  }

  /** @type {ParsedUserAgent["deviceType"]} */
  let deviceType = "Desktop";
  if (/iPad/.test(s) || (isAndroid && !/Mobile/.test(s))) {
    deviceType = "Tablet";
  } else if (isIos || isAndroid || /Mobile/.test(s)) {
    deviceType = "Mobile";
  }

  const webview = isAndroid && /; wv\)/.test(s);

  let browser = "Unknown";
  let browserVersion = "";
  /** @type {Array<[string, RegExp]>} ordered: vendor tokens before Chrome/Safari */
  const browsers = [
    ["Samsung Internet", /SamsungBrowser\/(\d+(?:\.\d+)*)/],
    ["Edge", /Edg(?:A|iOS)?\/(\d+(?:\.\d+)*)/],
    ["Opera", /OPR\/(\d+(?:\.\d+)*)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+(?:\.\d+)*)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+(?:\.\d+)*)/],
    ["Safari", /Version\/(\d+(?:\.\d+)*).*Safari/],
  ];
  for (const [name, re] of browsers) {
    const m = s.match(re);
    if (m) {
      browser = name;
      browserVersion = m[1] || "";
      break;
    }
  }
  if (webview && browser === "Chrome") browser = "Android WebView";

  return { browser, browserVersion, os, osVersion, deviceType, webview };
}
