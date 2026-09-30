import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(
  () => /** @type {Record<string, (...args: any[]) => any>} */ ({}),
);

const browser = vi.hoisted(() => ({
  location: { pathname: "/today", hash: "", search: "" },
  history: {
    state: null,
    pushState: vi.fn(),
    replaceState: vi.fn(),
    back: vi.fn(),
    go: vi.fn(),
  },
  /** Record the URL a push/replace handed to the engine. */
  pushedUrl: "",
  historyPushedUrl() {
    return this.pushedUrl;
  },
}));

vi.stubGlobal("location", browser.location);
vi.stubGlobal("history", browser.history);
vi.stubGlobal("window", {
  addEventListener: vi.fn((type, listener) => {
    listeners[type] = listener;
  }),
});
vi.stubGlobal("document", { addEventListener: vi.fn() });

/**
 * A minimal <dialog> double: tracks open state, records close() calls, and —
 * like a real <dialog> — dispatches a `close` event from close() so the
 * helper's native-close wiring runs.
 * @returns {HTMLDialogElement}
 */
function fakeDialog() {
  const dialog = /** @type {any} */ ({
    open: false,
    dataset: {},
    listeners: {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      (this.listeners.close || []).forEach((fn) => fn());
    },
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
  });
  return /** @type {HTMLDialogElement} */ (/** @type {unknown} */ (dialog));
}

async function popWithBack() {
  // Simulate the engine: history.back() swaps the state, popstate catches up.
  browser.history.back.mockImplementationOnce(() => {
    browser.history.state = { goodNeighborAppNavigation: 0 };
    browser.location.hash = "";
  });
  await listeners.popstate();
}

describe("dialog-history", () => {
  /** @type {Record<string, any>} */
  let dialogHistory;
  /** @type {Record<string, any>} */
  let router;

  beforeEach(async () => {
    browser.location.pathname = "/today";
    browser.history.state = null;
    browser.history.pushState.mockReset();
    browser.history.replaceState.mockReset();
    browser.history.back.mockReset();
    browser.history.go.mockReset();
    browser.history.pushState.mockImplementation((state, _t, route) => {
      browser.history.state = state;
      browser.pushedUrl = route || "";
      if (route) {
        if (route.startsWith("#")) browser.location.hash = route;
        else browser.location.pathname = route;
      }
    });
    browser.history.replaceState.mockImplementation((state, _t, route) => {
      browser.history.state = state;
      browser.pushedUrl = route || "";
      if (route && !route.startsWith("#")) {
        browser.location.pathname = route;
      }
    });
    browser.history.back.mockImplementation(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.pathname = "/today";
      browser.location.hash = "";
      browser.pushedUrl = "";
    });
    vi.resetModules();
    router = await import("./router.js");
    dialogHistory = await import("./dialog-history.js");
  });

  it("openOverlayDialog shows the dialog and pushes one sentinel per id", () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "logout");

    expect(dialog.open).toBe(true);
    expect(browser.history.pushState).toHaveBeenCalledOnce();
  });

  it("re-opening the same id does not push a duplicate entry", () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "logout");
    dialog.close();
    dialogHistory.openOverlayDialog(dialog, "logout");

    expect(browser.history.pushState).toHaveBeenCalledTimes(2);
    expect(dialog.open).toBe(true);
    expect(browser.history.state?.goodNeighborOverlay).toBe("logout");
  });

  it("a reused dialog's SECOND open→native-close still unwinds (regression #4)", async () => {
    const dialog = fakeDialog(); // reused element, like the feedback sheet
    dialogHistory.openOverlayDialog(dialog, "feedback");
    // First close: the native listener calls closeOverlay → engine back() →
    // popstate catches up (clears the pending marker).
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
    });
    dialog.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await listeners.popstate();
    expect(browser.history.state?.goodNeighborOverlay).toBeUndefined();

    dialogHistory.openOverlayDialog(dialog, "feedback");
    expect(browser.history.state?.goodNeighborOverlay).toBe("feedback");

    // Second close must ALSO unwind — this is what the once-only listener broke.
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
    });
    dialog.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await listeners.popstate();
    expect(browser.history.state?.goodNeighborOverlay).toBeUndefined();
  });

  it("awaitOverlayUnwind resolves after close lands (regression: the discard race)", async () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "cancel-confirm");
    // Engine: traversal completes inside back(); popstate follows on the
    // microtask queue exactly like a real browser.
    browser.history.back.mockImplementation(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
      void Promise.resolve().then(() => listeners.popstate());
    });

    // The handler pattern under test: close + await + continue. (The native
    // close event → closeOverlay → queued traversal → popstate resolves it.)
    dialog.close();
    await dialogHistory.awaitOverlayUnwind("cancel-confirm");

    // NOW the caller's continuation is safe: replaceRoute lands correctly.
    router.replaceRoute("/today");
    expect(browser.location.pathname).toBe("/today");
    expect(browser.history.state).toEqual({ goodNeighborAppNavigation: 0 });
  });

  it("awaitOverlayUnwind resolves immediately when nothing is open", async () => {
    await dialogHistory.awaitOverlayUnwind("never-opened");
    expect(browser.history.back).not.toHaveBeenCalled();
  });

  it("two different ids push two sentinels", () => {
    const a = fakeDialog();
    const b = fakeDialog();
    dialogHistory.openOverlayDialog(a, "analysis-delete");
    dialogHistory.openOverlayDialog(b, "analysis-edit");

    expect(browser.history.pushState).toHaveBeenCalledTimes(2);
    // Top of the stack is the last id opened.
    expect(browser.history.state?.goodNeighborOverlay).toBe("analysis-edit");
  });

  it("native close unwinds the sentinel via closeOverlay", async () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "logout");
    expect(browser.history.state?.goodNeighborOverlay).toBe("logout");
    expect(browser.historyPushedUrl()).toBe("#logout");

    dialog.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(browser.history.state?.goodNeighborOverlay).toBeUndefined();
  });

  it("system back closes the registered dialog without a route re-render", async () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "ticket-detail");
    const routeListener = vi.fn();
    const removeRoute = router.onRouteChange(routeListener);

    // Simulate the ENGINE's back fully: state swap + hash strip + popstate.
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
    });
    browser.history.state = { goodNeighborAppNavigation: 0 };
    await listeners.popstate();

    expect(dialog.open).toBe(false);
    expect(routeListener).not.toHaveBeenCalled();
    expect(browser.location.pathname).toBe("/today");
    removeRoute();
  });

  it("system back closes the live dialog a re-render registered, not a dead one", async () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "logout");
    // Simulate a host re-render handing over a FRESH dialog element bound
    // only through registerOverlayDialog.
    const fresh = fakeDialog();
    fresh.open = true;
    dialogHistory.registerOverlayDialog("logout", fresh);

    // The engine's back: sentinel gone, popstate fires.
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
    });
    browser.history.state = { goodNeighborAppNavigation: 0 };
    await listeners.popstate();

    // Only the live registry entry closes; the pre-re-render element is kept.
    expect(fresh.open).toBe(false);
    expect(dialog.open).toBe(true);
  });

  it("pops are idempotent: closing an already-closed dialog is a no-op", async () => {
    const dialog = fakeDialog();
    dialogHistory.openOverlayDialog(dialog, "attributions");
    dialog.close();

    await popWithBack();

    expect(browser.location.pathname).toBe("/today");
  });
});
