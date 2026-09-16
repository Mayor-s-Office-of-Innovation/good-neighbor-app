import { afterEach, describe, expect, it, vi } from "vitest";

import { isInAppBrowser, escapeUrlForPlatform } from "./browser-context.js";

afterEach(() => vi.unstubAllGlobals());

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_CHROME = `${IOS_SAFARI.replace("Safari/604.1", "")} CriOS/126.0.0.0 Mobile/15E148 Safari/604.1`;
const IOS_FIREFOX = `${IOS_SAFARI.replace("Safari/604.1", "")} FxiOS/128.0 Mobile/15E148 Safari/605.1.15`;
const IOS_FACEBOOK = `${IOS_SAFARI.replace("Safari/604.1", "")} FBAV/470.0.0.40.88`;
const IOS_INSTAGRAM = `${IOS_SAFARI.replace("Safari/604.1", "")} Instagram 320.0.0.0.0`;
const IOS_GMAIL = `${IOS_SAFARI.replace("Safari/604.1", "")} GmailApp`;
const IOS_OUTLOOK = `${IOS_SAFARI.replace("Safari/604.1", "")} Outlook-iOS/9400.0`;
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW = ANDROID_CHROME.replace(
  "Chrome/126.0.0.0 Mobile",
  "; wv) Chrome/126.0.0.0 Mobile",
);
const ANDROID_FACEBOOK = `${ANDROID_CHROME.replace("Mobile Safari/537.36", "")} [FB_IAB/FB4A;FBAV/470.0.0.40.88;]`;

describe("isInAppBrowser", () => {
  it("clears real mobile browsers", () => {
    expect(isInAppBrowser(IOS_SAFARI)).toBe(false);
    expect(isInAppBrowser(IOS_CHROME)).toBe(false);
    expect(isInAppBrowser(IOS_FIREFOX)).toBe(false);
    expect(isInAppBrowser(ANDROID_CHROME)).toBe(false);
  });

  it("flags known iOS webviews", () => {
    expect(isInAppBrowser(IOS_FACEBOOK)).toBe(true);
    expect(isInAppBrowser(IOS_INSTAGRAM)).toBe(true);
    expect(isInAppBrowser(IOS_GMAIL)).toBe(true);
    expect(isInAppBrowser(IOS_OUTLOOK)).toBe(true);
  });

  it("flags the Android WebView token and Facebook's in-app browser", () => {
    expect(isInAppBrowser(ANDROID_WEBVIEW)).toBe(true);
    expect(isInAppBrowser(ANDROID_FACEBOOK)).toBe(true);
  });

  it("is false without a navigator", () => {
    expect(isInAppBrowser("")).toBe(false);
    expect(isInAppBrowser(undefined)).toBe(false);
  });
});

describe("escapeUrlForPlatform", () => {
  it("hands iOS a plain https URL (target=_blank → Safari)", () => {
    vi.stubGlobal("location", {
      href: "https://gnp.example.org/check?code=ABC123",
    });
    const url = escapeUrlForPlatform(IOS_FACEBOOK);
    expect(url).toMatch(/^https:/);
  });

  it("wraps Android in an intent URL with an https fallback", () => {
    vi.stubGlobal("location", {
      href: "https://gnp.example.org/check?code=ABC123",
    });
    const url = escapeUrlForPlatform(ANDROID_WEBVIEW);
    expect(url).toMatch(
      /^intent:.*#Intent;scheme=https;S\.browser_fallback_url=/,
    );
    expect(url).toMatch(/end$/);
  });
});
