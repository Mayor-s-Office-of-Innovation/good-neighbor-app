import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collapseCard,
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";
import { getToasts } from "../state/toasts.js";
import {
  onDeletionsChange,
  pendingDeletedConditionIds,
} from "../state/pending-deletions.js";

let sequence = 0;
let problem;
beforeEach(() => {
  vi.useFakeTimers();
  problem = {
    checkId: "check",
    conditionId: `condition-${++sequence}`,
    artifactId: "artifact",
    title: "Litter",
  };
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(type) {
        this.type = type;
      }
    },
  );
});
afterEach(() => {
  for (const toast of getToasts()) toast.close(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

describe("undoable analysis card deletion", () => {
  it("hides immediately, protects enclosing renders, restores focus, and saves after ten seconds", async () => {
    const { host, close, focus } = fixture();
    const home = /** @type {any} */ ({ contains: (node) => node === host });
    const unsubscribe = onDeletionsChange((status) => {
      if (status === "pending") expect(isDeletingAnalysisCard(home)).toBe(true);
    });
    const commit = vi.fn();
    const render = vi.fn(() =>
      expect(isDeletingAnalysisCard(host)).toBe(false),
    );
    await deleteAnalysisCard(host, problem, commit, render);
    unsubscribe();
    expect(close).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(pendingDeletedConditionIds(problem)).toContain(problem.conditionId);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9999);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("Undo restores the card without calling the server, including after navigation", async () => {
    const { host } = fixture();
    const commit = vi.fn();
    await deleteAnalysisCard(host, problem, commit, () => {});
    host.isConnected = false;
    getToasts()[0].close(true);
    expect(pendingDeletedConditionIds(problem)).not.toContain(
      problem.conditionId,
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect(commit).not.toHaveBeenCalled();
  });

  it("dismiss commits once even after the originating view disconnects", async () => {
    const { host } = fixture();
    const commit = vi.fn();
    await deleteAnalysisCard(host, problem, commit, () => {
      host.isConnected = false;
    });
    const toast = getToasts()[0];
    toast.close();
    toast.close(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(commit).toHaveBeenCalledOnce();
    expect(host.dispatchEvent).not.toHaveBeenCalled();
  });

  it("restores failed deletions and reports an error outside the old dialog", async () => {
    const { host } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await deleteAnalysisCard(
      host,
      problem,
      () => Promise.reject(new Error("offline")),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(pendingDeletedConditionIds(problem)).not.toContain(
      problem.conditionId,
    );
    expect(getToasts()[0].title).toBe("Couldn't delete item");
    await vi.advanceTimersByTimeAsync(60000);
    expect(getToasts()).toHaveLength(1);
  });

  it("still offers Undo when the post-collapse view refresh fails", async () => {
    const { host, focus } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await deleteAnalysisCard(host, problem, vi.fn(), () =>
      Promise.reject(new Error("refresh failed")),
    );
    expect(getToasts()[0].action.label).toBe("Undo");
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("deletion animation", () => {
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
