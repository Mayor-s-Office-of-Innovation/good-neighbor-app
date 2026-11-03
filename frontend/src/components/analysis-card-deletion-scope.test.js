import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getTaskDeletionScope: vi.fn() }));
vi.mock("../services/api.js", () => api);
import { prepareCardDeletion } from "./analysis-card-deletion.js";
import { t } from "../i18n/i18n.js";

beforeEach(() => {
  api.getTaskDeletionScope.mockReset();
  vi.stubGlobal("document", {
    createElement: () => ({
      dataset: {},
      addEventListener(name, handler) {
        this[name] = handler;
      },
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

function fixture(problem) {
  let fallback;
  const button = {
    disabled: false,
    focus: vi.fn(),
    before: (node) => {
      fallback = node;
      node.remove = () => {
        fallback = undefined;
      };
    },
  };
  const copy = { textContent: "", setAttribute: vi.fn() };
  const host = /** @type {any} */ ({
    _activeProblem: problem,
    querySelector: (id) =>
      id === "#analysis-delete-confirm"
        ? button
        : id === "#analysis-delete-copy"
          ? copy
          : fallback,
  });
  return { host, button, copy, fallback: () => fallback };
}
it.each(["single", "duplicate", "group"])(
  "confirms the server's %s scope",
  async (kind) => {
    const problem = { taskId: "root" };
    const { host, button, copy } = fixture(problem);
    const targets = [{ taskId: "root" }, { taskId: "child" }];
    let finish = (result) => {
      void result;
    };
    api.getTaskDeletionScope.mockResolvedValueOnce({
      deletion: { kind: "single", targets: [{ taskId: "root" }] },
    });
    api.getTaskDeletionScope.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = prepareCardDeletion(host, problem);
    expect(button.disabled).toBe(true);
    await Promise.resolve();
    finish({ deletion: { kind, targets } });
    await loading;
    expect(button.disabled).toBe(false);
    expect(copy.textContent).toBe(
      t(`analysis.deleteDialog.${kind === "single" ? "text" : kind}`, {
        count: 2,
      }),
    );
    expect(problem["deletionTargets"]).toEqual(targets);
  },
);
it("keeps confirmation disabled after a scope lookup failure", async () => {
  const problem = { taskId: "root" };
  const { host, button, copy } = fixture(problem);
  api.getTaskDeletionScope.mockRejectedValueOnce(new Error("offline"));
  await prepareCardDeletion(host, problem);
  expect(button.disabled).toBe(true);
  expect(copy.textContent).toBe(t("analysis.deleteDialog.loadError"));
});
it("ignores a late result for a previously selected card", async () => {
  const problem = { taskId: "root" };
  const { host, button } = fixture(problem);
  let finish = (result) => {
    void result;
  };
  api.getTaskDeletionScope.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = prepareCardDeletion(host, problem);
  host._activeProblem = { taskId: "other" };
  finish({ deletion: { kind: "single", targets: [{ taskId: "root" }] } });
  await loading;
  expect(button.disabled).toBe(true);
  expect(problem["deletionTargets"]).toBeUndefined();
});

it("does not expand a selected-only confirmation when a slow group response arrives", async () => {
  const problem = { taskId: "root" };
  const { host, button, fallback } = fixture(problem);
  const selected = [{ taskId: "root" }];
  api.getTaskDeletionScope.mockResolvedValueOnce({
    deletion: { kind: "single", targets: selected },
  });
  let finish = (result) => {
    void result;
  };
  api.getTaskDeletionScope.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = prepareCardDeletion(host, problem);
  await Promise.resolve();
  fallback().click();
  expect(button.disabled).toBe(false);
  finish({
    deletion: { kind: "group", targets: [...selected, { taskId: "other" }] },
  });
  await loading;
  expect(problem["deletionMode"]).toBe("selected");
  expect(problem["deletionTargets"]).toEqual(selected);
});

it.each([
  { targets: [{ taskId: "root" }, { taskId: "child" }] },
  { targets: [{ taskId: "other" }] },
])(
  "rejects a selected-card response that names a group or another card",
  async ({ targets }) => {
    const problem = { taskId: "root" };
    const { host, button, fallback } = fixture(problem);
    api.getTaskDeletionScope.mockResolvedValueOnce({
      deletion: { kind: "group", targets },
    });
    await prepareCardDeletion(host, problem);
    expect(button.disabled).toBe(true);
    expect(fallback()).toBeUndefined();
    expect(problem["deletionTargets"]).toBeUndefined();
  },
);
