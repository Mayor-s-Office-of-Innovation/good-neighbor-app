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
  const reload = vi.fn();
  const sheets = new TaskSheets(
    /** @type {any} */ ({
      host: {},
      container: () => ({ append() {} }),
      onTaskUpdated,
      reload,
    }),
  );
  sheets._focusCard = vi.fn();
  const button = /** @type {any} */ (new Button());
  const dialog = {
    addEventListener: vi.fn(),
    openResults: vi.fn(),
    openProof: vi.fn(),
    open: vi.fn(),
    remove: vi.fn(),
  };
  vi.stubGlobal("document", { createElement: () => dialog });
  return { sheets, button, dialog, onTaskUpdated, reload };
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
  expect(f.dialog.openResults).not.toHaveBeenCalled();
  expect(f.onTaskUpdated).toHaveBeenCalledWith(
    expect.objectContaining({ status: "completed" }),
  );
  expect(f.reload).toHaveBeenCalledOnce();
});
it("resolves without loading the documentation module", async () => {
  const f = fixture();
  const load = vi.spyOn(f.sheets, "_loadUpdates");
  await f.sheets.openUpdates(task, f.button, "resolve");
  expect(load).not.toHaveBeenCalled();
  expect(f.onTaskUpdated).toHaveBeenCalledOnce();
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
    openProof: vi.fn(),
  };
  await f.sheets.openUpdates(task, f.button, "resolve");
  expect(f.onTaskUpdated).toHaveBeenCalledOnce();
  expect(f.sheets._updateDialog.openResults).not.toHaveBeenCalled();
  expect(f.sheets._updateDialog._open).toBe(true);
});

it.each(["timeline", "resolve", "results"])(
  "opens read-only reports in timeline mode even when %s is requested",
  async (mode) => {
    const f = fixture();
    f.sheets._options.readOnly = true;
    vi.spyOn(f.sheets, "_loadUpdates").mockResolvedValue(
      /** @type {any} */ ({}),
    );
    await f.sheets.openUpdates(task, f.button, mode);
    expect(save).not.toHaveBeenCalled();
    expect(f.dialog.openResults).not.toHaveBeenCalled();
    expect(f.dialog.open).toHaveBeenCalledWith(task, "timeline");
    expect(f.sheets._updateDialog.readOnly).toBe(true);
  },
);

function listener(dialog, name) {
  return dialog.addEventListener.mock.calls.find(([type]) => type === name)[1];
}

it("closes unchanged history without reloading and restores focus", async () => {
  const f = fixture();
  vi.spyOn(f.sheets, "_loadUpdates").mockResolvedValue(/** @type {any} */ ({}));
  await f.sheets.openUpdates(task, f.button);
  await listener(f.dialog, "taskupdateclosed")({ detail: { results: false } });
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.sheets._focusCard).toHaveBeenCalledWith(
    task.taskId,
    "update",
    f.button,
  );
});

it("joins the save refresh on close and restores focus after it finishes", async () => {
  const f = fixture();
  const pending = deferred();
  f.reload.mockReturnValue(pending.promise);
  vi.spyOn(f.sheets, "_loadUpdates").mockResolvedValue(/** @type {any} */ ({}));
  await f.sheets.openUpdates(task, f.button);
  listener(f.dialog, "taskupdated")({ detail: { task: saved.task } });
  await listener(f.dialog, "taskupdateclosed")({ detail: { results: false } });
  expect(f.reload).toHaveBeenCalledOnce();
  expect(f.sheets._focusCard).not.toHaveBeenCalled();
  pending.resolve(undefined);
  await vi.waitFor(() => expect(f.sheets._focusCard).toHaveBeenCalledOnce());
});

it("waits for resolution to save before reloading", async () => {
  const f = fixture();
  const pending = deferred();
  save.mockReturnValue(pending.promise);
  const opening = f.sheets.openUpdates(task, f.button, "resolve");
  expect(f.reload).not.toHaveBeenCalled();
  pending.resolve(saved);
  await opening;
  expect(f.reload).toHaveBeenCalledOnce();
});

it.each(["open", "completed", "completing", "resolving"])(
  "refreshes instead of resolving a stale card whose latest status is %s",
  async (status) => {
    const f = fixture();
    f.sheets._options.resolveTask = () => ({ ...task, status });
    const load = vi.spyOn(f.sheets, "_loadUpdates");
    await f.sheets.openUpdates(task, f.button, "resolve");
    expect(save).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.dialog.openResults).not.toHaveBeenCalled();
  },
);

it("keeps the saved documentation target when the worklist still has an older task", async () => {
  const f = fixture();
  f.sheets._options.resolveTask = () => task;
  vi.spyOn(f.sheets, "_loadUpdates").mockResolvedValue(/** @type {any} */ ({}));
  const completed = { ...saved.task, latestUpdateId: saved.update.updateId };
  await f.sheets.openUpdates(completed, f.button, "results");
  expect(save).not.toHaveBeenCalled();
  expect(f.dialog.openProof).toHaveBeenCalledWith(completed);
});

it.each(["open", "completed"])(
  "uses a newer timeline task instead of an older %s worklist record",
  async (status) => {
    const f = fixture();
    const fresh = { ...task, updatedAt: "2026-10-01T12:01:00Z" };
    f.sheets._options.resolveTask = () => ({
      ...task,
      status,
      updatedAt: "2026-10-01T12:00:00Z",
    });
    vi.spyOn(f.sheets, "_loadUpdates").mockResolvedValue(
      /** @type {any} */ ({}),
    );
    await f.sheets.openUpdates(fresh, f.button, "resolve");
    expect(save).toHaveBeenCalledOnce();
    expect(f.dialog.openResults).not.toHaveBeenCalled();
    expect(f.reload).toHaveBeenCalledOnce();
  },
);

it("blocks an older timeline task when the worklist has a newer completion", async () => {
  const f = fixture();
  f.sheets._options.resolveTask = () => ({
    ...saved.task,
    updatedAt: "2026-10-01T12:01:00Z",
  });
  await f.sheets.openUpdates(
    { ...task, updatedAt: "2026-10-01T12:00:00Z" },
    f.button,
    "resolve",
  );
  expect(save).not.toHaveBeenCalled();
  expect(f.reload).toHaveBeenCalledOnce();
});

it.each([0, 408, 500])(
  "recovers a lost resolution response (%s) after the worklist becomes completed",
  async (status) => {
    const f = fixture();
    const load = vi
      .spyOn(f.sheets, "_loadUpdates")
      .mockRejectedValue(new Error("missing chunk"));
    save.mockRejectedValueOnce(
      Object.assign(new Error("uncertain response"), { status }),
    );
    await f.sheets.openUpdates(task, f.button, "resolve");
    const firstKey = save.mock.calls[0][2];
    f.reload.mockClear();
    f.sheets._options.resolveTask = () => saved.task;
    load.mockResolvedValue(/** @type {any} */ ({}));
    errorToast.mock.calls[0][1]();
    await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][2]).toBe(firstKey);
    f.reload.mockClear();
    // Confirmed attempts must not authorize new resolves of terminal tasks.
    await f.sheets.openUpdates(task, f.button, "resolve");
    expect(save).toHaveBeenCalledTimes(2);
    expect(f.reload).toHaveBeenCalledOnce();
  },
);

it.each([400, 403, 409, 429])(
  "does not bypass current state after a definite rejection (%s)",
  async (status) => {
    const f = fixture();
    vi.spyOn(f.sheets, "_loadUpdates").mockRejectedValue(
      new Error("missing chunk"),
    );
    save.mockRejectedValueOnce(
      Object.assign(new Error("rejected"), { status }),
    );
    await f.sheets.openUpdates(task, f.button, "resolve");
    f.reload.mockClear();
    f.sheets._options.resolveTask = () => saved.task;
    errorToast.mock.calls[0][1]();
    await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
  },
);
