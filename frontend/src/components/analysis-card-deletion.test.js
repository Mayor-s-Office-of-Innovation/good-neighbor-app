import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collapseCard,
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";

afterEach(() => vi.unstubAllGlobals());
vi.stubGlobal(
  "CustomEvent",
  class {
    constructor(type) {
      this.type = type;
    }
  },
);

function fixture() {
  const close = vi.fn();
  const focus = vi.fn();
  const heading = { focus, matches: () => false, setAttribute: vi.fn() };
  const host = /** @type {any} */ ({
    isConnected: true,
    dispatchEvent: vi.fn(),
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: (selector) =>
      selector === "#analysis-delete-dialog" ? { close } : heading,
  });
  return { host, close, focus };
}
const problem = { conditionId: "condition", artifactId: "artifact" };

describe("analysis card deletion lifecycle", () => {
  it("defers session renders until the accepted deletion commits, then restores focus", async () => {
    const { host, close, focus } = fixture();
    const render = vi.fn(() =>
      expect(isDeletingAnalysisCard(host)).toBe(false),
    );
    await deleteAnalysisCard(
      host,
      problem,
      async () => {
        expect(isDeletingAnalysisCard(host)).toBe(true);
        expect(close).not.toHaveBeenCalled();
      },
      render,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("protects the enclosing home view while an embedded capture deletion commits", async () => {
    const { host } = fixture();
    const home = /** @type {any} */ ({ contains: (node) => node === host });
    const otherView = /** @type {any} */ ({ contains: () => false });
    await deleteAnalysisCard(
      host,
      problem,
      async () => {
        expect(isDeletingAnalysisCard(home)).toBe(true);
        expect(isDeletingAnalysisCard(otherView)).toBe(false);
      },
      () => {},
    );
    expect(isDeletingAnalysisCard(home)).toBe(false);
    expect(host.dispatchEvent).toHaveBeenCalledOnce();
  });

  it("leaves the dialog and card intact if the state update fails", async () => {
    const { host, close, focus } = fixture();
    const render = vi.fn();
    await expect(
      deleteAnalysisCard(
        host,
        problem,
        () => {
          throw new Error("refresh failed");
        },
        render,
      ),
    ).rejects.toThrow("refresh failed");
    expect(isDeletingAnalysisCard(host)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not render or focus a view removed during deletion", async () => {
    const { host, focus } = fixture();
    const render = vi.fn();
    await deleteAnalysisCard(
      host,
      problem,
      () => {
        host.isConnected = false;
      },
      render,
    );
    expect(render).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(isDeletingAnalysisCard(host)).toBe(false);
  });

  it("skips measurements and animation for reduced motion", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const card = /** @type {any} */ ({ getBoundingClientRect: vi.fn() });
    await collapseCard(card);
    expect(card.getBoundingClientRect).not.toHaveBeenCalled();
  });
});
