import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { t } from "../i18n/i18n.js";

const setup = vi.hoisted(() => ({
  requestSetupCode: vi.fn(),
  validateSetupCode: vi.fn(),
  registerDevice: vi.fn(),
  redeemEnrollmentGrant: vi.fn(),
  getSite: vi.fn(),
  saveDiscoveredBindings: vi.fn(),
  setSite: vi.fn(),
}));
vi.mock("../services/onboarding.js", () => ({
  formatSiteCode: (value) => value,
  requestSetupCode: setup.requestSetupCode,
  searchSites: vi.fn(),
  validateSetupCode: setup.validateSetupCode,
}));
vi.mock("../services/devices.js", () => ({
  registerDevice: setup.registerDevice,
  redeemEnrollmentGrant: setup.redeemEnrollmentGrant,
}));
vi.mock("../db.js", () => ({
  bindingFromSession: (session) => ({
    siteId: session.site?.siteId,
    deviceId: session.deviceId,
    bindingId: session.bindingId,
    physicalDeviceId: session.physicalDeviceId,
    token: session.token,
    refreshToken: session.refreshToken,
    tokenGeneration: session.tokenGeneration,
    accessLevel: session.accessLevel,
  }),
  getSite: setup.getSite,
  saveDiscoveredBindings: setup.saveDiscoveredBindings,
  setSite: setup.setSite,
}));

let readCodeFromUrl;
let readEnrollmentFromUrl;
let stripCodeFromUrl;
let stripEnrollmentFromUrl;
let SiteSetup;
let codeEntryView;
beforeAll(async () => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { get: () => true });
  ({
    readCodeFromUrl,
    readEnrollmentFromUrl,
    stripCodeFromUrl,
    stripEnrollmentFromUrl,
    SiteSetup,
  } = await import("./site-setup.js"));
  ({ codeEntryView } = await import("./site-setup.templates.js"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setup.validateSetupCode.mockReset();
  setup.registerDevice.mockReset();
  setup.redeemEnrollmentGrant.mockReset();
  setup.getSite.mockReset();
  setup.saveDiscoveredBindings.mockReset();
  setup.setSite.mockReset();
});

describe("Manager enrollment URLs", () => {
  it("keeps manager enrollment controls off the login page", () => {
    const markup = codeEntryView();
    expect(markup).toContain("Welcome to Good Neighbor.");
    expect(markup).toContain('id="code-input"');
    expect(markup).toContain('id="continue"');
    expect(markup).not.toContain("Need a new code?");
    expect(markup).not.toContain("Site Manager access");
    expect(markup).not.toContain("Enrollment link");
    expect(markup).not.toContain("Camera app");
  });

  it("reads both secret fragment fields", () => {
    vi.stubGlobal(
      "location",
      new URL(
        "/#enrollment_grant=grant-1&enrollment_token=secret&section=setup",
        "https://goodneighborsf.org",
      ),
    );
    expect(readEnrollmentFromUrl()).toEqual({
      grantId: "grant-1",
      token: "secret",
    });
  });

  it("removes enrollment secrets while preserving other fragment state", () => {
    vi.stubGlobal(
      "location",
      new URL(
        "/?theme=dark#enrollment_grant=grant-1&enrollment_token=secret&section=setup",
        "https://goodneighborsf.org",
      ),
    );
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    stripEnrollmentFromUrl();
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/?theme=dark#section=setup",
    );
  });

  it.each(["#enrollment_grant=grant-1&enrollment_token=secret", "#login=1"])(
    "never redeems on opening %s",
    (hash) => {
      vi.stubGlobal("location", new URL("https://goodneighborsf.org/" + hash));
      vi.stubGlobal("history", { replaceState: vi.fn() });
      vi.stubGlobal("window", { addEventListener: vi.fn() });
      const component = new SiteSetup();
      component.getAttribute = vi.fn(() => null);
      component.hasAttribute = vi.fn(() => false);
      component._render = vi.fn();
      component._redeemEnrollment = vi.fn();
      component.connectedCallback();
      expect(component._redeemEnrollment).not.toHaveBeenCalled();
      expect(setup.redeemEnrollmentGrant).not.toHaveBeenCalled();
      expect(component._checking).toBe(false);
    },
  );
  it("persists a redeemed Manager binding", async () => {
    setup.getSite.mockResolvedValue({ physicalDeviceId: "physical-1" });
    setup.redeemEnrollmentGrant.mockResolvedValue({
      deviceId: "binding-1",
      bindingId: "binding-1",
      physicalDeviceId: "physical-1",
      site: { siteId: "site-1", name: "Site One" },
      token: "access",
      refreshToken: "refresh",
      expiresIn: 900,
      tokenGeneration: 1,
      accessLevel: "manager",
    });
    setup.setSite.mockResolvedValue({ siteId: "site-1" });
    vi.stubGlobal("CustomEvent", class {});
    const component = new SiteSetup();
    component._cancelled = false;
    component._checking = true;
    component._committingSite = false;
    component._render = vi.fn();
    component.dispatchEvent = vi.fn();

    await component._redeemEnrollment({ grantId: "grant-1", token: "secret" });

    expect(setup.redeemEnrollmentGrant).toHaveBeenCalledWith(
      "grant-1",
      "secret",
      { physicalDeviceId: "physical-1" },
    );
    expect(setup.setSite).toHaveBeenCalledWith(
      "Site One",
      expect.objectContaining({
        bindingId: "binding-1",
        physicalDeviceId: "physical-1",
        accessLevel: "manager",
      }),
    );
    expect(component.dispatchEvent).toHaveBeenCalledOnce();
  });
});

describe("setup code URLs", () => {
  it.each([
    ["/#code=ABC123", "ABC123"],
    ["/?code=OLD123", "OLD123"],
    ["/?code=OLD123#code=ABC123", "ABC123"],
    ["/#code=%20ABC123%20", "ABC123"],
    ["/", ""],
  ])("reads %s", (path, expected) => {
    vi.stubGlobal("location", new URL(path, "https://goodneighborsf.org"));
    expect(readCodeFromUrl()).toBe(expected);
  });

  it.each([
    ["/?theme=dark#code=ABC123&section=setup", "/?theme=dark#section=setup"],
    ["/?code=OLD123&theme=dark#code=ABC123", "/?theme=dark"],
    ["/?code=OLD123#heading", "/#heading"],
    ["/#code=ABC123", "/"],
  ])(
    "removes codes from %s while preserving other URL values",
    (path, expected) => {
      vi.stubGlobal("location", new URL(path, "https://goodneighborsf.org"));
      const replaceState = vi.fn();
      vi.stubGlobal("history", { replaceState });
      stripCodeFromUrl();
      expect(replaceState).toHaveBeenCalledWith(null, "", expected);
    },
  );

  it("does not rewrite a URL without a code", () => {
    vi.stubGlobal(
      "location",
      new URL("https://goodneighborsf.org/?theme=dark#heading"),
    );
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    stripCodeFromUrl();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("site-switch validation", () => {
  const continueRect = () => ({
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    left: 0,
    right: 100,
    top: 0,
    bottom: 50,
    toJSON: () => ({}),
  });
  const touchEvent = (overrides = {}) => ({
    pointerType: "touch",
    pointerId: 7,
    button: 0,
    isPrimary: true,
    clientX: 50,
    clientY: 25,
    preventDefault: vi.fn(),
    currentTarget: {
      getBoundingClientRect: continueRect,
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.stubGlobal("Element", class {});
  });

  it("submits after a completed touch release inside Continue", () => {
    const component = new SiteSetup();
    component._form = { requestSubmit: vi.fn() };
    const button = new Element();
    button.getBoundingClientRect = continueRect;
    const down = touchEvent({ currentTarget: button });

    component._beginTouchSubmit(down);

    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(component._form.requestSubmit).not.toHaveBeenCalled();

    component._finishTouchSubmit(touchEvent({ currentTarget: button }));

    expect(component._form.requestSubmit).toHaveBeenCalledOnce();
  });

  it("does not submit when the touch is released outside Continue", () => {
    const component = new SiteSetup();
    component._form = { requestSubmit: vi.fn() };
    const button = new Element();
    button.getBoundingClientRect = continueRect;

    component._beginTouchSubmit(touchEvent({ currentTarget: button }));
    component._finishTouchSubmit(touchEvent({ clientX: 150 }));

    expect(component._form.requestSubmit).not.toHaveBeenCalled();
    expect(component._pendingTouchSubmit).toBeNull();
  });

  it("does not submit after pointer cancellation", () => {
    const component = new SiteSetup();
    component._form = { requestSubmit: vi.fn() };
    const button = new Element();
    button.getBoundingClientRect = vi.fn();

    component._beginTouchSubmit(touchEvent({ currentTarget: button }));
    component._onTouchPointerCancel();
    component._finishTouchSubmit(touchEvent());

    expect(component._form.requestSubmit).not.toHaveBeenCalled();
    expect(button.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("clears the gesture without submitting on a mismatched release", () => {
    const component = new SiteSetup();
    component._form = { requestSubmit: vi.fn() };
    const button = new Element();
    button.getBoundingClientRect = vi.fn();

    component._beginTouchSubmit(touchEvent({ currentTarget: button }));
    component._finishTouchSubmit(touchEvent({ pointerId: 8 }));
    component._finishTouchSubmit(touchEvent({ pointerId: 7 }));

    expect(component._form.requestSubmit).not.toHaveBeenCalled();
    expect(button.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("leaves mouse activation on the native form-submit path", () => {
    const component = new SiteSetup();
    component._form = { requestSubmit: vi.fn() };
    const event = {
      pointerType: "mouse",
      button: 0,
      preventDefault: vi.fn(),
    };

    component._beginTouchSubmit(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(component._form.requestSubmit).not.toHaveBeenCalled();
  });

  it("does not register or bind a site after cancellation during validation", async () => {
    let releaseValidation = () => {};
    setup.validateSetupCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseValidation = () =>
            resolve({
              ok: true,
              code: "ABC123",
              providerSite: { siteId: "site-2", name: "Second" },
            });
        }),
    );
    vi.stubGlobal("CustomEvent", class {});
    const component = new SiteSetup();
    component._otp = { value: "ABC123" };
    component._checking = false;
    component._validationGeneration = 0;
    component._cancelled = false;
    component._committingSite = false;
    component._targetSiteId = "site-2";
    component._render = vi.fn();
    component.dispatchEvent = vi.fn();

    const pending = component._validate();
    component._cancelSwitch();
    releaseValidation();
    await pending;

    expect(component.dispatchEvent).toHaveBeenCalledOnce();
    expect(setup.registerDevice).not.toHaveBeenCalled();
    expect(setup.setSite).not.toHaveBeenCalled();
  });

  it("does not bind a site after cancellation during device registration", async () => {
    setup.validateSetupCode.mockResolvedValue({
      ok: true,
      code: "ABC123",
      providerSite: { siteId: "site-2", name: "Second" },
    });
    let releaseRegistration = () => {};
    setup.registerDevice.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRegistration = () => resolve({ deviceId: "device-2" });
        }),
    );
    vi.stubGlobal("CustomEvent", class {});
    const component = new SiteSetup();
    component._otp = { value: "ABC123" };
    component._checking = false;
    component._validationGeneration = 0;
    component._cancelled = false;
    component._committingSite = false;
    component._targetSiteId = "site-2";
    component._render = vi.fn();
    component.dispatchEvent = vi.fn();

    const pending = component._validate();
    await vi.waitFor(() => expect(setup.registerDevice).toHaveBeenCalledOnce());
    component._cancelSwitch();
    releaseRegistration();
    await pending;

    expect(setup.setSite).not.toHaveBeenCalled();
  });

  it("restores the cancel control when binding persistence fails", async () => {
    setup.validateSetupCode.mockResolvedValue({
      ok: true,
      code: "ABC123",
      providerSite: { siteId: "site-2", name: "Second" },
    });
    setup.registerDevice.mockResolvedValue({
      deviceId: "device-2",
      token: "token",
      refreshToken: "refresh",
      expiresIn: 100,
      tokenGeneration: 1,
    });
    setup.setSite.mockRejectedValue(new Error("IndexedDB unavailable"));
    const component = new SiteSetup();
    component._otp = { value: "ABC123" };
    component._checking = false;
    component._validationGeneration = 0;
    component._cancelled = false;
    component._committingSite = false;
    component._targetSiteId = "site-2";
    component._render = vi.fn();

    await component._validate();

    expect(component._committingSite).toBe(false);
    expect(component._checking).toBe(false);
    expect(component._error).toBe(t("setup.error.save"));
  });
});

it.each([true, false])(
  "clears login override only after a saved session (manager: %s)",
  async (manager) => {
    const location = new URL(
      "https://goodneighborsf.org/?theme=dark#login=1&section=home",
    );
    vi.stubGlobal("location", location);
    vi.stubGlobal("history", {
      replaceState: (_state, _title, url) => {
        location.href = new URL(url, location).href;
      },
    });
    vi.stubGlobal("CustomEvent", class {});
    const session = {
      site: { siteId: "site-1", name: "Site" },
      deviceId: "device-1",
      token: "token",
      refreshToken: "refresh",
      expiresIn: 900,
    };
    setup.validateSetupCode.mockResolvedValue(
      manager
        ? { ok: true, enrollment: true, code: "ABC123" }
        : {
            ok: true,
            code: "ABC123",
            providerSite: { siteId: "site-1", name: "Site" },
          },
    );
    setup.registerDevice.mockResolvedValue(session);
    setup.redeemEnrollmentGrant.mockResolvedValue(session);
    setup.saveDiscoveredBindings.mockResolvedValue(undefined);
    setup.setSite.mockImplementation(async () => {
      expect(location.hash).toContain("login=1");
      return { siteId: "site-1" };
    });
    const component = new SiteSetup();
    Object.assign(component, {
      _otp: { value: "ABC123" },
      _checking: false,
      _validationGeneration: 0,
      _cancelled: false,
      _render: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    await component._validate();
    expect(location.href).toBe(
      "https://goodneighborsf.org/?theme=dark#section=home",
    );
    const { hasEnrollmentCredentials } = await import(
      "../services/startup-auth.js"
    );
    expect(hasEnrollmentCredentials(location.href)).toBe(false);
    expect(component.dispatchEvent).toHaveBeenCalledOnce();
  },
);

it.each([true, false])(
  "keeps the login override on persistence failure (manager: %s)",
  async (manager) => {
    vi.stubGlobal("location", new URL("https://goodneighborsf.org/#login=1"));
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    setup.validateSetupCode.mockResolvedValue(
      manager
        ? { ok: true, enrollment: true, code: "ABC123" }
        : {
            ok: true,
            code: "ABC123",
            providerSite: { siteId: "site-1", name: "Site" },
          },
    );
    const session = {
      site: { siteId: "site-1", name: "Site" },
      expiresIn: 900,
    };
    setup.registerDevice.mockResolvedValue(session);
    setup.redeemEnrollmentGrant.mockResolvedValue(session);
    setup.setSite.mockRejectedValue(new Error("storage failed"));
    const component = new SiteSetup();
    Object.assign(component, {
      _otp: { value: "ABC123" },
      _checking: false,
      _validationGeneration: 0,
      _cancelled: false,
      _render: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    await component._validate();
    expect(replaceState).not.toHaveBeenCalled();
    expect(component.dispatchEvent).not.toHaveBeenCalled();
  },
);

it("shows the translated wait message for throttled code redemption", async () => {
  setup.redeemEnrollmentGrant.mockRejectedValue(
    Object.assign(new Error(), { code: "code_attempts_limited" }),
  );
  const component = new SiteSetup();
  Object.assign(component, { _cancelled: false, _render: vi.fn() });
  await component._redeemEnrollment({ code: "A1B2C3" });
  expect(component._error).toBe(t("setup.enrollment.limited"));
  expect(setup.setSite).not.toHaveBeenCalled();
});

it("shows the translated wait message when registration is throttled after successful lookup", async () => {
  setup.validateSetupCode.mockResolvedValue({
    ok: true,
    code: "ABC123",
    providerSite: { siteId: "site-2", name: "Synthetic site" },
  });
  setup.registerDevice.mockRejectedValue(
    Object.assign(new Error("limited"), { status: 429 }),
  );
  const component = new SiteSetup();
  component._otp = { value: "ABC123" };
  component._checking = false;
  component._validationGeneration = 0;
  component._cancelled = false;
  component._render = vi.fn();
  await component._validate();
  expect(component._checking).toBe(false);
  expect(component._error).toBe(t("setup.enrollment.limited"));
  expect(setup.setSite).not.toHaveBeenCalled();
});

it("shows the translated wait message for a general-WAF enrollment throttle", async () => {
  setup.redeemEnrollmentGrant.mockRejectedValue(
    Object.assign(new Error("limited"), { status: 429, code: "rate_limited" }),
  );
  setup.getSite.mockResolvedValue(null);
  const component = new SiteSetup();
  component._cancelled = false;
  component._render = vi.fn();
  await component._redeemEnrollment({ code: "ABC123" });
  expect(component._error).toBe(t("setup.enrollment.limited"));
  expect(setup.setSite).not.toHaveBeenCalled();
});

it.each([
  ["limited", "setup.enrollment.limited"],
  ["invalid", "setup.error.requestInvalid"],
  ["network", "setup.error.request"],
])(
  "maps email-code request reason %s to its localized message",
  async (reason, key) => {
    setup.requestSetupCode.mockResolvedValue({ ok: false, reason });
    const component = new SiteSetup();
    Object.assign(component, {
      _request: {
        selectedSiteId: "site-test",
        email: "synthetic@example.test",
        requesting: false,
      },
      _syncRequestSubmit: vi.fn(),
      _render: vi.fn(),
    });
    await component._requestCode();
    expect(component._request.error).toBe(t(key));
    expect(component._request.requesting).toBe(false);
  },
);
