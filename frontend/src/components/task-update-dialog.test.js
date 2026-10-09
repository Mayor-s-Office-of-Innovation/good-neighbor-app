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

describe("standalone 311 editors", () => {
  async function editor(mode) {
    const { TaskUpdateDialog } = await import("./task-update-dialog.js");
    const dialog = new TaskUpdateDialog();
    dialog._editorOnly = true;
    dialog._cityHelpNeeded = true;
    dialog._mode = mode;
    dialog._task = {
      taskId: "ticket-task",
      checkId: "check-1",
      status: "in_progress",
    };
    dialog._open = true;
    dialog.querySelector = vi.fn(() => ({ close: vi.fn() }));
    dialog.dispatchEvent = vi.fn();
    dialog._load = vi.fn();
    return dialog;
  }
  const root = () =>
    /** @type {HTMLElement} */ (
      /** @type {unknown} */ ({
        querySelectorAll: () => [],
        querySelector: () => null,
      })
    );

  it("saves an informational action and closes without a resolution or photo step", async () => {
    const { createTaskUpdate } = await import("../services/api.js");
    vi.mocked(createTaskUpdate).mockResolvedValue({});
    const dialog = await editor("action");
    dialog._actionText = "  Called the agency  ";
    expect(dialog._content()).toContain("data-save-action");
    expect(dialog._content()).not.toContain("data-action-outcome");
    await dialog._saveAction(root());
    expect(createTaskUpdate).toHaveBeenLastCalledWith(
      "ticket-task",
      {
        type: "additional_action",
        text: "Called the agency",
        photoKeys: [],
        cityHelpNeeded: true,
      },
      expect.any(String),
    );
    expect(dialog._open).toBe(false);
    expect(dialog._load).not.toHaveBeenCalled();
    expect(
      vi.mocked(dialog.dispatchEvent).mock.calls.map(([event]) => event.type),
    ).toEqual(["taskupdated", "taskupdateclosed"]);
  });

  it("persists notes and uploaded photo keys before closing", async () => {
    const { createTaskUpdate } = await import("../services/api.js");
    vi.mocked(createTaskUpdate).mockResolvedValue({});
    const dialog = await editor("notes");
    dialog._noteDrafts = [" New photo ", "", ""];
    dialog._uploadFiles = vi.fn().mockResolvedValue(["photo-1"]);
    await dialog._saveNotes(root());
    expect(createTaskUpdate).toHaveBeenLastCalledWith(
      "ticket-task",
      {
        type: "note_photo_update",
        notes: ["New photo"],
        photoKeys: ["photo-1"],
        cityHelpNeeded: true,
      },
      expect.any(String),
    );
    expect(dialog._open).toBe(false);
  });

  it("preserves the action draft and stays open after a save fails", async () => {
    const { createTaskUpdate } = await import("../services/api.js");
    vi.mocked(createTaskUpdate).mockRejectedValue(new Error("offline"));
    const dialog = await editor("action");
    dialog._actionText = "Called the agency";
    await dialog._saveAction(root());
    expect(dialog._actionText).toBe("Called the agency");
    expect(dialog._open).toBe(true);
    expect(dialog.dispatchEvent).not.toHaveBeenCalled();
  });
});

it("keeps the same request id when retrying a 311 City note", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const { createTaskUpdate } = await import("../services/api.js");
  vi.mocked(createTaskUpdate).mockResolvedValue({});
  const dialog = new TaskUpdateDialog();
  dialog._editorOnly = true;
  dialog._task = { taskId: "task1" };
  dialog._cityHelpNeeded = false;
  const body = {
    type: "additional_action",
    text: "Followed up",
    photoKeys: [],
  };
  await dialog._createUpdate({ ...body });
  await dialog._createUpdate({ ...body });
  const calls = vi.mocked(createTaskUpdate).mock.calls.slice(-2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0][1].cityHelpNeeded).toBe(false);
  dialog._cityHelpNeeded = true;
  await dialog._createUpdate({ ...body });
  expect(vi.mocked(createTaskUpdate).mock.lastCall[2]).not.toBe(calls[0][2]);
});

it("recognizes 311 editors entered from the shared task timeline", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  const ticket = {
    taskId: "311-task",
    status: "in_progress",
    presencePromptDue: true,
    appActionResults: [
      { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
    ],
  };
  dialog._load = vi.fn();
  await dialog.open(ticket);
  expect(dialog._editorOnly).toBe(false);
  expect(dialog._cityHelpNeeded).toBeNull();
  expect(dialog._content()).not.toContain("data-presence");
  const handlers = new Map();
  const root = /** @type {HTMLDialogElement} */ (
    /** @type {unknown} */ ({
      querySelectorAll: (selector) =>
        selector === "[data-mode]"
          ? ["notes", "action"].map((mode) => ({
              dataset: { mode },
              addEventListener: (_, fn) => handlers.set(mode, fn),
            }))
          : [],
      querySelector: () => null,
    })
  );
  dialog._render = vi.fn();
  dialog._wire(root);
  for (const mode of ["notes", "action"]) {
    handlers.get(mode)();
    expect(dialog._content()).toContain("data-city-help");
    expect(dialog._content()).not.toContain("data-action-outcome");
    expect(dialog._cityHelpNeeded).toBeNull();
    dialog._cityHelpNeeded = false;
  }
  dialog._close = vi.fn();
  dialog._notifyUpdated = vi.fn();
  vi.mocked(dialog._load).mockClear();
  await dialog._finishSave();
  expect(dialog._close).not.toHaveBeenCalled();
  expect(dialog._mode).toBe("timeline");
  expect(dialog._open).toBe(true);
  expect(dialog._load).toHaveBeenCalledOnce();
  expect(dialog._notifyUpdated).toHaveBeenCalledOnce();
  await dialog.open({ taskId: "normal", status: "in_progress" });
  handlers.get("action")();
  expect(dialog._cityHelpNeeded).toBeUndefined();
  expect(dialog._content()).not.toContain("data-city-help");
  expect(dialog._content()).toContain("data-action-outcome");
});

it.each(["notes", "action"])(
  "returns a closed 311 %s editor to its shared timeline",
  async (mode) => {
    const { TaskUpdateDialog } = await import("./task-update-dialog.js");
    const dialog = new TaskUpdateDialog();
    dialog._load = vi.fn();
    dialog.dispatchEvent = vi.fn();
    await dialog.open({
      taskId: "311-task",
      appActionResults: [
        { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
      ],
    });
    vi.mocked(dialog._load).mockClear();
    dialog._mode = mode;
    await dialog._close();
    expect(dialog._mode).toBe("timeline");
    expect(dialog._open).toBe(true);
    expect(dialog._load).toHaveBeenCalledOnce();
    expect(dialog.dispatchEvent).not.toHaveBeenCalled();
    dialog._mode = mode;
    dialog._cityHelpNeeded = false;
    await dialog._close(true);
    expect(dialog._mode).toBe("timeline");
    expect(dialog._open).toBe(true);
    expect(dialog._cityHelpNeeded).toBeNull();
    expect(dialog.dispatchEvent).not.toHaveBeenCalled();
    dialog._mode = mode;
    vi.mocked(dialog._load).mockClear();
    await dialog._finishSave();
    expect(dialog._mode).toBe("timeline");
    expect(dialog._open).toBe(true);
    expect(dialog._load).toHaveBeenCalledOnce();
    expect(
      vi.mocked(dialog.dispatchEvent).mock.calls.map(([event]) => event.type),
    ).toEqual(["taskupdated"]);
  },
);
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
    api.createTaskUpdate.mockReset().mockResolvedValue({
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

it("resets workflow state when reusing a 311 editor for completion results and back", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  dialog._load = vi.fn();
  dialog._render = vi.fn();
  const ticket = {
    taskId: "ticket",
    appActionResults: [
      { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
    ],
  };
  await dialog.open(ticket, "notes");
  dialog._cityHelpNeeded = false;
  dialog._noteDrafts = ["Old draft", "", ""];
  dialog.openResults({ taskId: "completed", latestUpdateId: "result-1" });
  expect(dialog._editorOnly).toBe(false);
  expect(dialog._results).toBe(true);
  expect(dialog._cityHelpNeeded).toBeUndefined();
  expect(dialog._noteDrafts.every((note) => !note)).toBe(true);
  expect(dialog._content()).not.toContain("data-city-help");
  expect(dialog._pendingEvent.updateId).toBe("result-1");

  await dialog.open(ticket, "action");
  expect(dialog._results).toBe(false);
  expect(dialog._editorOnly).toBe(true);
  expect(dialog._pendingEvent).toBeNull();
  expect(dialog._cityHelpNeeded).toBeNull();
  expect(dialog._content()).toContain("data-city-help");
  expect(dialog._content()).not.toContain("data-action-outcome");
});
