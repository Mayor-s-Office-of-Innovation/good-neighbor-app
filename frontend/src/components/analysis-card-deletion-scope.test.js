import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getTaskDetails: vi.fn() }));
vi.mock("../services/api.js", () => api);
import { prepareCardDeletion } from "./analysis-card-deletion.js";
import { t } from "../i18n/i18n.js";

function fixture(problem) {
  const button = { disabled: false };
  const copy = { textContent: "" };
  const host = /** @type {any} */ ({
    _activeProblem: problem,
    querySelector: (id) => (id === "#analysis-delete-confirm" ? button : copy),
  });
  return { host, button, copy };
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
    api.getTaskDetails.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = prepareCardDeletion(host, problem);
    expect(button.disabled).toBe(true);
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
  api.getTaskDetails.mockRejectedValueOnce(new Error("offline"));
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
  api.getTaskDetails.mockImplementationOnce(
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
