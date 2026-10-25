import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock("./analytics.js", () => ({ trackEvent: mocks.trackEvent }));

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1";
const IOS_GMAIL =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GmailApp/6.0 Safari/604.1";
const IPADOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; rv:126.0) Gecko/20100101 Firefox/126.0";

function fakeWindow() {
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  return {
    handlers,
    addEventListener: (type, fn) => (handlers[type] ||= []).push(fn),
    fire: (type, event) => handlers[type]?.forEach((fn) => fn(event)),
    matchMedia: () => ({ matches: false }),
  };
}

/** @returns {Storage} */
function memoryStorage() {
  const map = new Map();
  return /** @type {any} */ ({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
  });
}

let mod;
beforeEach(async () => {
  vi.resetModules();
  mocks.trackEvent.mockReset();
  mod = await import("./install-prompt.js");
});
afterEach(() => {
  mod.resetInstallPrompt();
  vi.unstubAllGlobals();
});

describe("isIosSafari", () => {
  it("accepts iPhone Safari and iPadOS desktop-class Safari", () => {
    expect(mod.isIosSafari(IOS_SAFARI, { platform: "iPhone" })).toBe(true);
    expect(
      mod.isIosSafari(IPADOS, { platform: "MacIntel", maxTouchPoints: 5 }),
    ).toBe(true);
  });

  it("rejects a real Mac, third-party iOS browsers and in-app webviews", () => {
    expect(
      mod.isIosSafari(IPADOS, { platform: "MacIntel", maxTouchPoints: 0 }),
    ).toBe(false);
    expect(mod.isIosSafari(IOS_CHROME, { platform: "iPhone" })).toBe(false);
    expect(mod.isIosSafari(IOS_GMAIL, { platform: "iPhone" })).toBe(false);
    expect(mod.isIosSafari(ANDROID_CHROME, {})).toBe(false);
  });
});

describe("installMethod", () => {
  it("is ios on Safari, prompt on Chromium, null elsewhere", () => {
    expect(mod.installMethod(IOS_SAFARI, { platform: "iPhone" })).toBe("ios");
    expect(mod.installMethod(ANDROID_CHROME, {})).toBe("prompt");
    expect(mod.installMethod(FIREFOX, {})).toBe(null);
  });
});

describe("shouldOfferInstall", () => {
  const now = 1_700_000_000_000;

  it("offers a fresh eligible browser", () => {
    expect(mod.shouldOfferInstall({ now, state: {}, method: "ios" })).toBe(
      true,
    );
  });

  it("never offers standalone, webview, installed or unsupported browsers", () => {
    const base = { now, state: {}, method: /** @type {const} */ ("prompt") };
    expect(mod.shouldOfferInstall({ ...base, standalone: true })).toBe(false);
    expect(mod.shouldOfferInstall({ ...base, webview: true })).toBe(false);
    expect(
      mod.shouldOfferInstall({ ...base, state: { installed: true } }),
    ).toBe(false);
    expect(mod.shouldOfferInstall({ ...base, method: null })).toBe(false);
  });

  it("snoozes for two weeks after a dismissal, then stops for good", () => {
    const one = { dismissedAt: now, dismissals: 1 };
    expect(
      mod.shouldOfferInstall({ now: now + 1000, state: one, method: "ios" }),
    ).toBe(false);
    expect(
      mod.shouldOfferInstall({
        now: now + mod.SNOOZE_MS + 1,
        state: one,
        method: "ios",
      }),
    ).toBe(true);
    const two = { dismissedAt: now - mod.SNOOZE_MS * 10, dismissals: 2 };
    expect(mod.shouldOfferInstall({ now, state: two, method: "ios" })).toBe(
      false,
    );
  });
});

describe("dismissInstall", () => {
  it("records the time and counts dismissals in localStorage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mod.dismissInstall(123);
    mod.dismissInstall(456);
    expect(mod.readState(storage)).toEqual({ dismissedAt: 456, dismissals: 2 });
  });

  it("tolerates a localStorage getter that throws (blocked site data)", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError: access is denied");
      },
    });
    expect(mod.readState()).toEqual({});
    expect(() => mod.dismissInstall(1)).not.toThrow();
    expect(mod.shouldOfferInstall({ method: "ios" })).toBe(true);
  });

  it("survives a storage that throws", () => {
    const broken = /** @type {any} */ ({
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    });
    expect(mod.readState(broken)).toEqual({});
    expect(() => mod.writeState({ dismissals: 1 }, broken)).not.toThrow();
  });
});

describe("captureInstallPrompt / promptInstall", () => {
  it("holds beforeinstallprompt, notifies subscribers and replays it once", async () => {
    const w = fakeWindow();
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mod.captureInstallPrompt(/** @type {any} */ (w));
    mod.captureInstallPrompt(/** @type {any} */ (w)); // idempotent
    expect(w.handlers.beforeinstallprompt).toHaveLength(1);

    const available = vi.fn();
    mod.onInstallAvailable(available);
    expect(mod.hasHeldPrompt()).toBe(false);

    const event = {
      preventDefault: vi.fn(),
      prompt: vi.fn(async () => {}),
      userChoice: Promise.resolve({ outcome: "accepted" }),
    };
    w.fire("beforeinstallprompt", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(available).toHaveBeenCalledOnce();
    expect(mod.hasHeldPrompt()).toBe(true);
    expect(mod.installMethod(FIREFOX, {})).toBe("prompt");

    expect(await mod.promptInstall()).toBe("accepted");
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(mod.readState(storage)).toEqual({ installed: true });
    expect(await mod.promptInstall()).toBe(null);
  });

  it("clears a stale installed flag when the browser offers again", () => {
    const w = fakeWindow();
    const storage = memoryStorage();
    storage.setItem(mod.STORAGE_KEY, JSON.stringify({ installed: true }));
    vi.stubGlobal("window", { localStorage: storage });
    mod.captureInstallPrompt(/** @type {any} */ (w));
    w.fire("beforeinstallprompt", { preventDefault() {} });
    expect(mod.readState(storage)).toEqual({ installed: false });
    expect(
      mod.shouldOfferInstall({
        state: mod.readState(storage),
        method: "prompt",
      }),
    ).toBe(true);
  });

  it("notifies onAppInstalled subscribers and drops the held event", () => {
    const w = fakeWindow();
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    mod.captureInstallPrompt(/** @type {any} */ (w));
    w.fire("beforeinstallprompt", { preventDefault() {} });
    const installed = vi.fn();
    const unsubscribe = mod.onAppInstalled(installed);
    w.fire("appinstalled", {});
    expect(installed).toHaveBeenCalledOnce();
    expect(mod.hasHeldPrompt()).toBe(false);
    unsubscribe();
    w.fire("appinstalled", {});
    expect(installed).toHaveBeenCalledOnce();
  });

  it("marks the app installed on appinstalled", () => {
    const w = fakeWindow();
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mod.captureInstallPrompt(/** @type {any} */ (w));
    w.fire("appinstalled", {});
    expect(mod.readState(storage).installed).toBe(true);
    expect(mocks.trackEvent).toHaveBeenCalledWith("app_installed", {});
    expect(
      mod.shouldOfferInstall({
        state: mod.readState(storage),
        method: "prompt",
      }),
    ).toBe(false);
  });
});

it("permanently stops offers after a completed perimeter check and notifies the mounted banner", () => {
  const storage = memoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
  const remove = vi.fn();
  const unsubscribe = mod.onFirstPerimeterCheckCompleted(remove);
  mod.completeFirstPerimeterCheck();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(mod.readState()).toMatchObject({ firstCheckCompleted: true });
  expect(
    mod.shouldOfferInstall({
      method: "ios",
      standalone: false,
      webview: false,
    }),
  ).toBe(false);
  mod.resetInstallPrompt();
  expect(
    mod.shouldOfferInstall({
      method: "ios",
      standalone: false,
      webview: false,
    }),
  ).toBe(false);
  unsubscribe();
});
it("stops offers for this session even if browser storage is blocked", () => {
  vi.stubGlobal("window", {
    get localStorage() {
      throw new Error("blocked");
    },
  });
  mod.completeFirstPerimeterCheck();
  expect(
    mod.shouldOfferInstall({
      method: "ios",
      state: {},
      standalone: false,
      webview: false,
    }),
  ).toBe(false);
});
