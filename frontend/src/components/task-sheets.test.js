import { beforeEach, afterEach, expect, it, vi } from "vitest";
const { save, toast, errorToast } = vi.hoisted(() => ({
  save: vi.fn(),
  toast: vi.fn(),
  errorToast: vi.fn(),
}));
vi.mock("./ticket-detail-dialog.js", () => ({}));
vi.mock("./analysis-card-completion.js", () => ({
  holdCompletionCard: () => vi.fn(),
  slideCompletedCard: vi.fn(),
}));
vi.mock("../services/api.js", () => ({ createTaskUpdate: save }));
vi.mock("../state/toasts.js", () => ({
  showToast: toast,
  showTaskUpdateErrorToast: errorToast,
}));
import { TaskSheets } from "./task-sheets.js";
import { t } from "../i18n/i18n.js";
class Button {
  disabled = false;
  textContent = "resolve";
  setAttribute() {}
  removeAttribute() {}
}
function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const task = { taskId: "task", status: "in_progress", checkId: "check" };
const saved = {
  task: { ...task, status: "completed", canUploadPhotos: true },
  update: { updateId: "update" },
};
function fixture() {
  const onTaskUpdated = vi.fn();
  const sheets = new TaskSheets(
    /** @type {any} */ ({
      host: {},
      container: () => ({ append() {} }),
      onTaskUpdated,
    }),
  );
  sheets._focusCard = vi.fn();
  const button = /** @type {any} */ (new Button());
  const dialog = {
    addEventListener: vi.fn(),
    openResults: vi.fn(),
    open: vi.fn(),
    remove: vi.fn(),
  };
  vi.stubGlobal("document", { createElement: () => dialog });
  return { sheets, button, dialog, onTaskUpdated };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("HTMLButtonElement", Button);
  save.mockResolvedValue(saved);
});
afterEach(() => vi.unstubAllGlobals());
it("starts saving before the dialog module loads and shows immediate pending feedback", async () => {
  const f = fixture();
  const module = deferred(),
    response = deferred();
  vi.spyOn(f.sheets, "_loadUpdates").mockReturnValue(
    /** @type {any} */ (module.promise),
  );
  save.mockReturnValue(response.promise);
  const opening = f.sheets.openUpdates(task, f.button, "resolve");
  expect(save).toHaveBeenCalledOnce();
  expect(f.button.disabled).toBe(true);
  expect(f.button.textContent).toBe(t("taskUpdate.resolving"));
  await f.sheets.openUpdates(task, f.button, "resolve");
  expect(save).toHaveBeenCalledOnce();
  response.resolve(saved);
  await Promise.resolve();
  expect(f.onTaskUpdated).not.toHaveBeenCalled();
  expect(f.dialog.openResults).not.toHaveBeenCalled();
  module.resolve({});
  await opening;
  expect(f.dialog.openResults).toHaveBeenCalledOnce();
  expect(f.onTaskUpdated).not.toHaveBeenCalled();
  const close = f.dialog.addEventListener.mock.calls.find(
    ([name]) => name === "taskupdateclosed",
  )[1];
  await close({ detail: { results: true } });
  expect(f.onTaskUpdated).toHaveBeenCalledWith(
    expect.objectContaining({ status: "completed", latestUpdateId: "update" }),
  );
});
it("reports successful resolution despite a missing module and retries only documentation", async () => {
  const f = fixture();
  const load = vi
    .spyOn(f.sheets, "_loadUpdates")
    .mockRejectedValue(new Error("missing chunk"));
  await f.sheets.openUpdates(task, f.button, "resolve");
  expect(f.onTaskUpdated).toHaveBeenCalledOnce();
  expect(errorToast).not.toHaveBeenCalled();
  const notice = toast.mock.calls.at(-1)?.[0];
  expect(notice.title).toBe(t("taskUpdate.formUnavailableResolved"));
  load.mockResolvedValue(/** @type {any} */ ({}));
  notice.action.run();
  await vi.waitFor(() => expect(f.dialog.openResults).toHaveBeenCalled());
  expect(save).toHaveBeenCalledOnce();
  expect(f.dialog.openResults.mock.calls[0][0].latestUpdateId).toBe("update");
});
it("keeps the same idempotency key when retrying an uncertain save", async () => {
  const f = fixture();
  vi.spyOn(f.sheets, "_loadUpdates").mockRejectedValue(
    new Error("missing chunk"),
  );
  save.mockRejectedValueOnce(new Error("timeout"));
  await f.sheets.openUpdates(task, f.button, "resolve");
  expect(f.button.disabled).toBe(false);
  expect(f.onTaskUpdated).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  errorToast.mock.calls[0][1]();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][2]).toBe(save.mock.calls[0][2]);
});
it("reports timeline module failures without attempting resolution", async () => {
  const f = fixture();
  vi.spyOn(f.sheets, "_loadUpdates").mockRejectedValue(new Error("offline"));
  await f.sheets.openUpdates(task, f.button);
  expect(save).not.toHaveBeenCalled();
  expect(toast.mock.calls[0][0].title).toBe(t("taskUpdate.formUnavailable"));
});

it("preserves another form's unsaved work and offers documentation-only recovery", async () => {
  const f = fixture();
  vi.spyOn(f.sheets, "_loadUpdates").mockResolvedValue(/** @type {any} */ ({}));
  f.sheets._updateDialog = {
    _open: true,
    _task: { taskId: "other" },
    _hasUnsavedDraft: () => true,
    openResults: vi.fn(),
  };
  await f.sheets.openUpdates(task, f.button, "resolve");
  expect(f.onTaskUpdated).toHaveBeenCalledOnce();
  expect(f.sheets._updateDialog.openResults).not.toHaveBeenCalled();
  expect(toast.mock.calls.at(-1)?.[0].title).toBe(
    t("taskUpdate.finishCurrentForm"),
  );
});
