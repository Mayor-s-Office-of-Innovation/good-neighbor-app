import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reportClientEvent: vi.fn() }));

vi.mock("../services/error-report.js", () => ({
  reportClientEvent: mocks.reportClientEvent,
}));

function warningRoot({ connected = true } = {}) {
  let hasBanner = false;
  const host = {
    insertAdjacentHTML: vi.fn(() => {
      hasBanner = true;
    }),
  };
  return {
    isConnected: connected,
    querySelector: vi.fn((selector) => {
      if (selector === ".webview-banner") return hasBanner ? {} : null;
      if (selector === ".app__main") return host;
      return null;
    }),
    host,
  };
}

beforeEach(() => {
  mocks.reportClientEvent.mockReset();
});

describe("showWebviewWarning", () => {
  it("is idempotent when overlapping imports resolve", async () => {
    const { showWebviewWarning } = await import("./webview-warning.js");
    const root = warningRoot();

    showWebviewWarning(/** @type {any} */ (root));
    showWebviewWarning(/** @type {any} */ (root));

    expect(root.host.insertAdjacentHTML).toHaveBeenCalledOnce();
    expect(mocks.reportClientEvent).toHaveBeenCalledOnce();
  });

  it("ignores a root that was disconnected while the module loaded", async () => {
    const { showWebviewWarning } = await import("./webview-warning.js");
    const root = warningRoot({ connected: false });

    showWebviewWarning(/** @type {any} */ (root));

    expect(root.host.insertAdjacentHTML).not.toHaveBeenCalled();
    expect(mocks.reportClientEvent).not.toHaveBeenCalled();
  });
});
