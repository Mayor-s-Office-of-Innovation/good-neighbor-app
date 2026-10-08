import { beforeAll, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  uploadTaskUpdatePhoto: vi.fn(),
  documentTaskUpdate: vi.fn(),
  createTaskUpdate: vi.fn(),
}));
const toasts = vi.hoisted(() => ({
  showTaskUpdateErrorToast: vi.fn(),
}));
vi.mock("../services/api.js", () => ({
  ApiError: class ApiError extends Error {},
  createTaskUpdate: api.createTaskUpdate,
  documentTaskUpdate: api.documentTaskUpdate,
  getMediaUrl: vi.fn(),
  getTaskUpdates: vi.fn(),
  uploadTaskUpdatePhoto: api.uploadTaskUpdatePhoto,
}));
vi.mock("../state/toasts.js", () => toasts);

beforeAll(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { define: vi.fn() });
});

describe("task-update-dialog controller", () => {
  it("registers a controller whose draft detection delegates to domain state", async () => {
    await import("./task-update-dialog.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "task-update-dialog");
    const Dialog = /** @type {any} */ (registration[1]);
    const dialog = new Dialog();

    dialog._mode = "action";
    dialog._actionText = "Followed up";
    expect(dialog._hasUnsavedDraft()).toBe(true);
    dialog._mode = "timeline";
    expect(dialog._hasUnsavedDraft()).toBe(false);
  });

  it("keeps a dirty editor open until discard is confirmed", async () => {
    await import("./task-update-dialog.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "task-update-dialog");
    const Dialog = /** @type {any} */ (registration[1]);
    const dialog = new Dialog();
    dialog._mode = "action";
    dialog._actionText = "Draft action";
    dialog._showDiscard = vi.fn();
    dialog._sealPendingEvent = vi.fn();
    dialog._resetDraft = vi.fn();
    dialog._load = vi.fn();

    await dialog._close();
    expect(dialog._showDiscard).toHaveBeenCalledOnce();
    expect(dialog._load).not.toHaveBeenCalled();

    await dialog._close(true);
    expect(dialog._mode).toBe("timeline");
    expect(dialog._resetDraft).toHaveBeenCalledOnce();
    expect(dialog._load).toHaveBeenCalledOnce();
  });

  it("emits the host refresh event through one controller method", async () => {
    await import("./task-update-dialog.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "task-update-dialog");
    const Dialog = /** @type {any} */ (registration[1]);
    const dialog = new Dialog();
    dialog.dispatchEvent = vi.fn();

    dialog._notifyUpdated();
    expect(dialog.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "taskupdated" }),
    );
  });

  it("restores controls and shows a failure toast after a failed mutation", async () => {
    await import("./task-update-dialog.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "task-update-dialog");
    const Dialog = /** @type {any} */ (registration[1]);
    const dialog = new Dialog();
    const button = { disabled: false };
    const error = { hidden: true, textContent: "" };
    const root = {
      querySelectorAll: vi.fn(() => [button]),
      querySelector: vi.fn(() => error),
    };

    await expect(
      dialog._runMutation(root, "button", () =>
        Promise.reject(new Error("offline")),
      ),
    ).resolves.toBeNull();
    expect(button.disabled).toBe(false);
    expect(error).toEqual({ hidden: true, textContent: "" });
    expect(toasts.showTaskUpdateErrorToast).toHaveBeenCalledOnce();
  });

  it("reuses a successful per-file upload throughout the draft", async () => {
    await import("./task-update-dialog.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "task-update-dialog");
    const Dialog = /** @type {any} */ (registration[1]);
    const dialog = new Dialog();
    const file = /** @type {File} */ ({});
    dialog._task = { taskId: "task-1", checkId: "check-1" };
    api.uploadTaskUpdatePhoto.mockResolvedValue({ artifactId: "photo-1" });

    await expect(dialog._uploadFile(file)).resolves.toBe("photo-1");
    await expect(dialog._uploadFile(file)).resolves.toBe("photo-1");
    expect(api.uploadTaskUpdatePhoto).toHaveBeenCalledTimes(1);
    expect(api.uploadTaskUpdatePhoto).toHaveBeenCalledWith(
      "task-1",
      "check-1",
      {
        file,
        capturedAt: expect.any(String),
      },
    );
  });
});

it.each(["save", "skip", "failure"])(
  "handles completion results: %s",
  async (kind) => {
    const { TaskUpdateDialog } = await import("./task-update-dialog.js");
    const dialog = /** @type {any} */ (new TaskUpdateDialog());
    dialog._render = vi.fn();
    dialog.dispatchEvent = vi.fn();
    const modal = {
      close: vi.fn(),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    dialog.querySelector = vi.fn(() => modal);
    dialog.openResults({ taskId: "task-1", latestUpdateId: "update-1" });
    dialog._uploadFiles = vi.fn().mockResolvedValue(["photo-1"]);
    dialog._noteDrafts = [" Work completed ", "", ""];
    api.documentTaskUpdate.mockReset();
    if (kind === "failure")
      api.documentTaskUpdate.mockRejectedValue(new Error("offline"));
    else api.documentTaskUpdate.mockResolvedValue({ update: {} });
    if (kind === "skip") await dialog._finishDocumentation(modal, [], []);
    else await dialog._saveNotes(modal);
    expect(api.documentTaskUpdate).toHaveBeenCalledWith("task-1", "update-1", {
      notes: kind === "skip" ? [] : ["Work completed"],
      photoKeys: kind === "skip" ? [] : ["photo-1"],
    });
    expect(dialog._open).toBe(kind === "failure");
    expect(dialog._pendingEvent === null).toBe(kind !== "failure");
  },
);

it.each([false, true])(
  "documents the existing additional action (skip: %s)",
  async (skip) => {
    const { TaskUpdateDialog } = await import("./task-update-dialog.js");
    const dialog = /** @type {any} */ (new TaskUpdateDialog());
    dialog._task = { taskId: "task-1" };
    dialog._pendingEvent = { updateId: "action-1" };
    dialog._actionText = "Followed up";
    dialog._load = vi.fn();
    dialog._notifyUpdated = vi.fn();
    dialog._uploadFiles = vi.fn().mockResolvedValue(["photo-1"]);
    api.documentTaskUpdate.mockReset().mockResolvedValue({ update: {} });
    await dialog._saveAction({ querySelectorAll: () => [] }, skip);
    expect(api.documentTaskUpdate).toHaveBeenCalledWith("task-1", "action-1", {
      notes: [],
      photoKeys: skip ? [] : ["photo-1"],
    });
    expect(dialog._pendingEvent).toBeNull();
    expect(dialog._actionText).toBe("");
    expect(dialog._load).toHaveBeenCalledOnce();
    expect(dialog._notifyUpdated).toHaveBeenCalledOnce();
  },
);

it("retains a conflicted result draft until the user confirms discard", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const { ApiError } = await import("../services/api.js");
  const dialog = /** @type {any} */ (new TaskUpdateDialog());
  dialog._render = vi.fn();
  dialog._showDiscard = vi.fn();
  dialog.dispatchEvent = vi.fn();
  const modal = { close: vi.fn(), querySelectorAll: () => [] };
  dialog.querySelector = vi.fn(() => modal);
  dialog.openResults({ taskId: "task-1", latestUpdateId: "update-1" });
  dialog._noteDrafts = ["Keep this note", "", ""];
  dialog._uploadFiles = vi.fn().mockResolvedValue(["photo-1"]);
  api.documentTaskUpdate.mockReset().mockRejectedValue(
    Object.assign(new ApiError("conflict"), {
      status: 409,
      body: { code: "DocumentationConflict" },
    }),
  );
  await dialog._saveNotes(modal);
  expect(dialog._noteDrafts[0]).toBe("Keep this note");
  expect(dialog._open).toBe(true);
  expect(dialog._pendingEvent).toBeNull();
  await dialog._saveNotes(modal);
  expect(api.documentTaskUpdate).toHaveBeenCalledTimes(1);
  await dialog._close();
  expect(dialog._showDiscard).toHaveBeenCalledOnce();
  expect(dialog._open).toBe(true);
  await dialog._close(true);
  expect(dialog._open).toBe(false);
});

it.each([undefined, "Followed up"])(
  "records presence or action before documentation: %s",
  async (text) => {
    const { TaskUpdateDialog } = await import("./task-update-dialog.js");
    const dialog = /** @type {any} */ (new TaskUpdateDialog());
    dialog._task = { taskId: "task-1" };
    dialog._render = vi.fn();
    dialog._notifyUpdated = vi.fn();
    api.createTaskUpdate
      .mockReset()
      .mockResolvedValue({
        task: dialog._task,
        update: { updateId: "update-1" },
      });
    const type = text ? "additional_action_resolved" : "presence_resolved";
    await dialog._recordOutcome({ querySelectorAll: () => [] }, type, text);
    expect(api.createTaskUpdate).toHaveBeenCalledWith("task-1", {
      type,
      ...(text ? { text } : {}),
    });
    expect(dialog._pendingEvent.updateId).toBe("update-1");
    expect(dialog._mode).toBe(text ? "action-photos" : "notes");
  },
);

it("saves notes for a check-free task without attempting a photo upload", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = /** @type {any} */ (new TaskUpdateDialog());
  dialog._render = vi.fn();
  dialog.dispatchEvent = vi.fn();
  const modal = { querySelectorAll: () => [], close: vi.fn() };
  dialog.querySelector = vi.fn(() => modal);
  dialog.openResults({
    taskId: "task-1",
    latestUpdateId: "update-1",
    canUploadPhotos: false,
  });
  dialog._noteDrafts = ["Area cleaned", "", ""];
  api.uploadTaskUpdatePhoto.mockClear();
  api.documentTaskUpdate.mockReset().mockResolvedValue({ update: {} });
  await dialog._saveNotes(modal);
  expect(api.uploadTaskUpdatePhoto).not.toHaveBeenCalled();
  expect(api.documentTaskUpdate).toHaveBeenCalledWith("task-1", "update-1", {
    notes: ["Area cleaned"],
    photoKeys: [],
  });
  expect(dialog._open).toBe(false);
});
