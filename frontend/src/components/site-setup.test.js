import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const setup = vi.hoisted(() => ({
  validateSetupCode: vi.fn(),
  registerDevice: vi.fn(),
  setSite: vi.fn(),
}));
vi.mock("../services/onboarding.js", () => ({
  formatSiteCode: (value) => value,
  requestSetupCode: vi.fn(),
  searchSites: vi.fn(),
  validateSetupCode: setup.validateSetupCode,
}));
vi.mock("../services/devices.js", () => ({
  registerDevice: setup.registerDevice,
}));
vi.mock("../db.js", () => ({ setSite: setup.setSite }));

let readCodeFromUrl;
let stripCodeFromUrl;
let SiteSetup;
beforeAll(async () => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { get: () => true });
  ({ readCodeFromUrl, stripCodeFromUrl, SiteSetup } = await import(
    "./site-setup.js"
  ));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setup.validateSetupCode.mockReset();
  setup.registerDevice.mockReset();
  setup.setSite.mockReset();
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
    expect(component._error).toMatch(/couldn't save this site/);
  });
});
