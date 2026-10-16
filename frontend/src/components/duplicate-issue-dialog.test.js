import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { setDuplicateUiSite } from "../services/feature-flags.js";
import { t } from "../i18n/i18n.js";

const separate = vi.hoisted(() => vi.fn());
const unwind = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/api.js", () => ({ separateDuplicate: separate }));
vi.mock("../services/photo-analysis.js", () => ({
  restartDuplicateChecks: vi.fn(),
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));
vi.mock("./task-sheets.js", () => ({ TaskSheets: class {} }));
vi.mock("../dialog-history.js", () => ({
  awaitOverlayUnwind: unwind,
  openOverlayDialog: (dialog) => {
    dialog.open = true;
  },
}));

// Minimal native-dialog fixture: handlers and lifecycle are real component code.
class Node {
  listeners = new Map();
  attributes = new Map();
  isConnected = true;
  focus = vi.fn();
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  async click() {
    await this.listeners.get("click")?.();
  }
}
let host;
let definition;
let openDuplicateIssue;
let nodes;
class Host extends Node {
  set innerHTML(_value) {
    nodes = new Map([
      [
        "dialog",
        Object.assign(new Node(), {
          open: false,
          close: vi.fn(() => {
            const dialog = nodes.get("dialog");
            if (!dialog.open) return;
            dialog.open = false;
            dialog.listeners.get("close")?.();
          }),
        }),
      ],
      ...["close", "original", "separate"].map(
        /** @returns {[string, Node]} */
        (name) => [`[data-duplicate-${name}]`, new Node()],
      ),
      [
        ".duplicate-detail__link",
        Object.assign(new Node(), {
          append: (message) => nodes.set('[role="alert"]', message),
        }),
      ],
    ]);
  }
  querySelector(selector) {
    return nodes?.get(selector) ?? null;
  }
  remove() {
    this.isConnected = false;
    this.disconnectedCallback();
  }
  disconnectedCallback() {}
}
const task = {
  taskId: "repeat",
  createdAt: "2026-10-15T12:00:00Z",
  duplicate: {
    sourceRevision: "r1",
    original: {
      taskId: "original",
      createdAt: "2026-10-14T12:00:00Z",
      status: "open",
    },
  },
};
let trigger;
let handlers;
beforeAll(async () => {
  vi.stubGlobal("HTMLElement", Host);
  vi.stubGlobal("customElements", {
    define: (name, component) => {
      definition = { name, component };
    },
  });
  ({ openDuplicateIssue } = await import("./duplicate-issue-dialog.js"));
});
beforeEach(() => {
  nodes = undefined;
  host = undefined;
  trigger = new Host();
  handlers = { onSeparated: vi.fn(), onOriginal: vi.fn() };
  separate.mockReset();
  unwind.mockClear();
  vi.stubGlobal("document", {
    createElement: (name) =>
      name === definition.name ? new definition.component() : new Node(),
    body: {
      append: (element) => {
        host = element;
      },
    },
    querySelectorAll: () => [],
  });
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
});
afterEach(() => {
  host?.remove();
  setDuplicateUiSite(null);
});

it("registers a custom element and respects the flag before mounting", () => {
  expect(definition.name).toBe("duplicate-issue-dialog");
  setDuplicateUiSite(null);
  openDuplicateIssue(task, trigger, handlers);
  expect(host).toBeUndefined();
});
it("closes on flag changes and restores focus", () => {
  openDuplicateIssue(task, trigger, handlers);
  expect(host).toBeInstanceOf(definition.component);
  expect(nodes.get("dialog").open).toBe(true);
  setDuplicateUiSite(null);
  expect(host.isConnected).toBe(false);
  expect(trigger.focus).toHaveBeenCalledOnce();
});
it("unsubscribes when removed externally", () => {
  openDuplicateIssue(task, trigger, handlers);
  const dialog = nodes.get("dialog");
  host.remove();
  dialog.close.mockClear();
  setDuplicateUiSite(null);
  expect(dialog.close).not.toHaveBeenCalled();
});
it("closes and unwinds history before opening the original", async () => {
  openDuplicateIssue(task, trigger, handlers);
  await nodes.get("[data-duplicate-original]").click();
  expect(unwind).toHaveBeenCalledWith("duplicate-repeat");
  expect(handlers.onOriginal.mock.calls[0]?.[0]).toBe(task.duplicate.original);
  expect(handlers.onOriginal.mock.calls[0]?.[1]).toBe(trigger);
  expect(host.isConnected).toBe(false);
});
it("retains the dialog on separation failure and allows retry", async () => {
  separate
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ task: { taskId: "repeat" } });
  openDuplicateIssue(task, trigger, handlers);
  const button = nodes.get("[data-duplicate-separate]");
  await button.click();
  expect(nodes.get("dialog").open).toBe(true);
  expect(button.attributes.has("disabled")).toBe(false);
  expect(nodes.get('[role="alert"]').textContent).toBe(
    t("duplicate.separateError"),
  );
  await button.click();
  expect(separate).toHaveBeenLastCalledWith("repeat", {
    sourceRevision: "r1",
    originalTaskId: "original",
  });
  expect(handlers.onSeparated).toHaveBeenCalledWith({ taskId: "repeat" });
  expect(host.isConnected).toBe(false);
});
