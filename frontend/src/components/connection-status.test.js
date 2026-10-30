import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Tests for components/connection-status.js — the OUTAGE toast + AUTH dialog
  surface (api-response-integrity plan §3b). Node environment: the class is
  exercised directly (no real DOM registration — customElements is stubbed);
  sign-out wiring is the regression target: it must clear the in-memory
  session + ALL site-scoped stores (a binding-only clear would leak the
  previous site's drafts into a different site's binding) and reset the
  health state so the dialog can't re-open over the setup form.
*/

/** @type {{ state: string }} */
let healthModule;

vi.mock("../services/backend-health.js", () => ({
  getHealthState: vi.fn(() => healthModule.state),
  onHealthChange: vi.fn(() => () => {}),
  clearAuthState: vi.fn(),
  clearAccessState: vi.fn(),
}));
vi.mock("../services/session-handoff.js", () => ({
  retireHandoff: vi.fn(async () => false),
}));
vi.mock("../db.js", () => ({
  clearSiteSession: vi.fn(async () => {}),
}));
vi.mock("../state/check-session.js", () => ({
  discardInMemorySession: vi.fn(),
}));
vi.mock("../state/toasts.js", () => ({
  showOfflinePhotosToast: vi.fn(),
}));

beforeEach(() => {
  healthModule = { state: "healthy" };
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    "CustomEvent",
    class CustomEventMock {
      /** @param {string} type */
      constructor(type) {
        this.type = type;
      }
    },
  );
  vi.stubGlobal("HTMLElement", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

const load = () => import("./connection-status.js");

/** Element double: records innerHTML, supports querySelector by id/class. */
function makeElement() {
  const listeners = {};
  const dialogs = [];
  const nodes = {
    "#conn-auth-title": { textContent: "" },
    "#conn-auth-message": { textContent: "" },
  };
  const dialog = {
    open: false,
    showModal() {
      dialog.open = true;
      dialogs.push("showModal");
    },
    close() {
      dialog.open = false;
    },
    addEventListener: (t, fn) => (listeners[t] = fn),
  };
  const signout = {
    textContent: "",
    addEventListener: (t, fn) => (listeners.signout = fn),
  };
  /** The live banner element (null when none) — `remove()` detaches it. */
  let banner = /** @type {any} */ (null);
  const el = {
    /** @returns {any} the current banner, if mounted */
    get _banner() {
      return banner;
    },
    _html: "",
    _children: [],
    /** @param {string} value */
    set innerHTML(value) {
      this._html = value;
      this._children = [];
      banner = null; // innerHTML resets the element tree
    },
    /** @returns {string} */
    get innerHTML() {
      return this._html ?? "";
    },
    insertAdjacentHTML(_pos, markup) {
      this._children.push(markup);
      // Mount a removable banner node, as the real DOM would.
      banner = { remove: () => (banner = null), bound: false, markup };
    },
    querySelector(/** @type {string} */ selector) {
      if (selector === "#conn-auth-signout") {
        return signout;
      }
      if (selector === "#conn-auth-dialog") {
        return dialog;
      }
      if (selector === "#conn-auth-cancel")
        return { addEventListener: (t, fn) => (listeners.cancelClick = fn) };
      if (nodes[selector]) return nodes[selector];
      if (selector === ".conn-banner") {
        return banner ? banner : null;
      }
      if (selector === ".conn-banner__close") {
        return banner && !banner.bound
          ? ((banner.bound = true),
            {
              addEventListener: (t, fn) => (listeners["banner-close"] = fn),
            })
          : null;
      }
      return null;
    },
    _listeners: listeners,
    _dialogs: dialogs,
  };
  return el;
}

/**
 * Mount the real prototype methods onto a fresh element double.
 * @param {any} ConnectionStatus
 * @returns {Promise<any>} the wired element
 */
async function mount(ConnectionStatus) {
  const el = makeElement();
  const proto = ConnectionStatus.prototype;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key !== "constructor" && key !== "connectedCallback") {
      el[key] = proto[key];
    }
  }
  await proto.connectedCallback.call(el);
  return el;
}

describe("sign-out handler (fix 2 + 3)", () => {
  it("clears the in-memory session + all site-scoped stores, then emits authsignout", async () => {
    const { default: ConnectionStatus } = await load();
    const { discardInMemorySession } = await import(
      "../state/check-session.js"
    );
    const { clearSiteSession } = await import("../db.js");
    const { clearAuthState } = await import("../services/backend-health.js");

    const el = makeElement();
    // Merge the class prototype so _sync/_unsubscribe exist on the double.
    Object.assign(Object.getPrototypeOf(el) ?? el, {});
    const proto = ConnectionStatus.prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== "constructor" && key !== "connectedCallback") {
        el[key] = proto[key];
      }
    }
    await proto.connectedCallback.call(el);

    expect(el._listeners.signout).toBeTypeOf("function");

    // Fire the sign-out button.
    await el._listeners.signout();

    expect(discardInMemorySession).toHaveBeenCalled();
    expect(clearSiteSession).toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "authsignout" }),
    );
    // app-root's authsignout handler calls clearAuthState (fix 2) — asserted
    // at that level; here just confirm the event is the only channel used.
    expect(clearAuthState).not.toHaveBeenCalled();
  });

  it("does NOT show the AUTH dialog when healthy (no modal over setup)", async () => {
    const { default: ConnectionStatus } = await load();
    const el = makeElement();
    const proto = ConnectionStatus.prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== "constructor" && key !== "connectedCallback") {
        el[key] = proto[key];
      }
    }
    await proto.connectedCallback.call(el);

    expect(el._dialogs).toHaveLength(0); // never opened
  });

  it("opens the modal only in the auth state", async () => {
    const { default: ConnectionStatus } = await load();
    healthModule.state = "auth";
    const el = await mount(ConnectionStatus);
    expect(el._dialogs).toContain("showModal");
  });
});

describe("permission and session dialog recovery", () => {
  it.each(["auth", "access"])(
    "shows distinct copy for %s and lets Cancel preserve local work",
    async (state) => {
      const { default: ConnectionStatus } = await load();
      const { t } = await import("../i18n/i18n.js");
      const { clearSiteSession } = await import("../db.js");
      const { discardInMemorySession } = await import(
        "../state/check-session.js"
      );
      healthModule.state = state;
      const el = await mount(ConnectionStatus);
      const prefix =
        state === "access"
          ? "connection.accessDenied"
          : "connection.authExpired";
      expect(el.querySelector("#conn-auth-title").textContent).toBe(
        t(`${prefix}.title`),
      );
      expect(el.querySelector("#conn-auth-message").textContent).toBe(
        t(`${prefix}.message`),
      );
      el._listeners.cancelClick();
      expect(el.querySelector("#conn-auth-dialog").open).toBe(false);
      el._sync();
      expect(el.querySelector("#conn-auth-dialog").open).toBe(false);
      expect(clearSiteSession).not.toHaveBeenCalled();
      expect(discardInMemorySession).not.toHaveBeenCalled();
      expect(window.dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it("allows Escape to dismiss the dialog without signing out", async () => {
    const { default: ConnectionStatus } = await load();
    healthModule.state = "auth";
    const el = await mount(ConnectionStatus);
    const preventDefault = vi.fn();
    el._listeners.cancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(el.querySelector("#conn-auth-dialog").open).toBe(false);
  });
});

describe("outage communication", () => {
  it("leaves connection loss to the shared banner without opening an authentication dialog", async () => {
    const { default: ConnectionStatus } = await load();
    const el = await mount(ConnectionStatus);
    healthModule.state = "outage";
    el._sync();
    expect(el.querySelector("#conn-auth-dialog").open).toBe(false);
    healthModule.state = "healthy";
    el._sync();
    expect(el.querySelector("#conn-auth-dialog").open).toBe(false);
  });
});
