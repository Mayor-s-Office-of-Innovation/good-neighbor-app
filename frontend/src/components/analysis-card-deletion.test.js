import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collapseCard,
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
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
});

describe("accepted deletion refresh recovery", () => {
  it("preserves success and restores focus when refresh rejects", async () => {
    const { host, focus } = fixture();
    const error = new Error("storage unavailable");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      deleteAnalysisCard(
        host,
        problem,
        () => {},
        () => Promise.reject(error),
      ),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "refresh after analysis deletion failed",
      error,
    );
    expect(host.dispatchEvent).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(isDeletingAnalysisCard(host)).toBe(false);
  });

  it("does not dispatch or focus after refresh disconnects the host", async () => {
    const { host, focus } = fixture();
    await deleteAnalysisCard(
      host,
      problem,
      () => {},
      () => {
        host.isConnected = false;
      },
    );
    expect(host.dispatchEvent).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["finished", "cancelled", "disabled"])(
    "cleans up the card when CSS animation is %s",
    async (completion) => {
      let finish = () => {};
      /** @type {(error: Error) => void} */
      let cancel = () => {};
      const finished = new Promise((resolve, reject) => {
        finish = () => resolve(undefined);
        cancel = reject;
      });
      const clip = { append: vi.fn() };
      const shell = {
        append: vi.fn(),
        remove: vi.fn(),
        getAnimations: () => (completion === "disabled" ? [] : [{ finished }]),
      };
      vi.stubGlobal("document", {
        createElement: vi
          .fn()
          .mockReturnValueOnce(shell)
          .mockReturnValueOnce(clip),
      });
      const card = /** @type {any} */ ({ before: vi.fn() });
      const collapsed = collapseCard(card);
      expect(card.inert).toBe(true);
      expect(shell.remove).not.toHaveBeenCalled();
      if (completion === "finished") finish();
      if (completion === "cancelled") cancel(new Error("View removed"));
      await collapsed;
      expect(shell.remove).toHaveBeenCalledOnce();
    },
  );
});
