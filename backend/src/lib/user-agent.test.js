import { describe, expect, it } from "vitest";
import { parseUserAgent } from "./user-agent.js";

const UAS = {
  oldAndroidChrome:
    "Mozilla/5.0 (Linux; Android 8.0.0; SM-G930F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.181 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 9; SAMSUNG SM-J737A) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36",
  webview:
    "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 11; SM-T500) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/117.0.5938.117 Mobile/15E148 Safari/604.1",
  desktopChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  firefoxAndroid:
    "Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0",
  edgeAndroid:
    "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36 EdgA/118.0.2088.69",
};

describe("parseUserAgent", () => {
  it("reads old Android Chrome with the OS version", () => {
    expect(parseUserAgent(UAS.oldAndroidChrome)).toEqual({
      browser: "Chrome",
      browserVersion: "88.0.4324.181",
      os: "Android",
      osVersion: "8.0.0",
      deviceType: "Mobile",
      webview: false,
    });
  });

  it("prefers the Samsung Internet token over the embedded Chrome token", () => {
    const parsed = parseUserAgent(UAS.samsung);
    expect(parsed.browser).toBe("Samsung Internet");
    expect(parsed.browserVersion).toBe("14.2");
    expect(parsed.os).toBe("Android");
    expect(parsed.osVersion).toBe("9");
  });

  it("flags Android WebViews", () => {
    const parsed = parseUserAgent(UAS.webview);
    expect(parsed.browser).toBe("Android WebView");
    expect(parsed.webview).toBe(true);
    expect(parsed.deviceType).toBe("Mobile");
  });

  it("classifies Android without the Mobile token as a tablet", () => {
    expect(parseUserAgent(UAS.androidTablet).deviceType).toBe("Tablet");
  });

  it("reads iOS Safari and Chrome on iOS", () => {
    expect(parseUserAgent(UAS.iosSafari)).toMatchObject({
      browser: "Safari",
      browserVersion: "16.6",
      os: "iOS",
      osVersion: "16.6",
      deviceType: "Mobile",
    });
    expect(parseUserAgent(UAS.iosChrome)).toMatchObject({
      browser: "Chrome",
      browserVersion: "117.0.5938.117",
      os: "iOS",
      osVersion: "17.0",
    });
  });

  it("reads desktop, Firefox, and Edge", () => {
    expect(parseUserAgent(UAS.desktopChrome)).toMatchObject({
      browser: "Chrome",
      os: "Mac OS X",
      osVersion: "10.15.7",
      deviceType: "Desktop",
    });
    expect(parseUserAgent(UAS.firefoxAndroid)).toMatchObject({
      browser: "Firefox",
      browserVersion: "120.0",
      os: "Android",
      osVersion: "13",
      deviceType: "Mobile",
    });
    expect(parseUserAgent(UAS.edgeAndroid)).toMatchObject({
      browser: "Edge",
      browserVersion: "118.0.2088.69",
    });
  });

  it("never throws on junk", () => {
    expect(parseUserAgent(undefined)).toEqual({
      browser: "Unknown",
      browserVersion: "",
      os: "Unknown",
      osVersion: "",
      deviceType: "Desktop",
      webview: false,
    });
    expect(parseUserAgent("").browser).toBe("Unknown");
  });
});
