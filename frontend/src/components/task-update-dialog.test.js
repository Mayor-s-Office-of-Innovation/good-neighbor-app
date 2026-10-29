import { beforeAll, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  uploadTaskUpdatePhoto: vi.fn(),
  documentTaskUpdate: vi.fn(),
  createTaskUpdate: vi.fn(),
  getTaskUpdates: vi.fn(),
  getMediaUrl: vi.fn(),
  get311RequestDetails: vi.fn(),
}));
const toasts = vi.hoisted(() => ({
  showTaskUpdateErrorToast: vi.fn(),
}));
vi.mock("../services/api.js", () => ({
  ApiError: class ApiError extends Error {},
  createTaskUpdate: api.createTaskUpdate,
  documentTaskUpdate: api.documentTaskUpdate,
  getMediaUrl: api.getMediaUrl,
  getTaskUpdates: api.getTaskUpdates,
  get311RequestDetails: api.get311RequestDetails,
  uploadTaskUpdatePhoto: api.uploadTaskUpdatePhoto,
}));
vi.mock("../state/toasts.js", () => toasts);

beforeAll(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("requestAnimationFrame", (callback) => setTimeout(callback, 0));
  vi.stubGlobal("cancelAnimationFrame", (id) => clearTimeout(id));
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
    expect(error).toMatchObject({
      hidden: true,
      textContent: "",
      inert: false,
    });
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
      expect.objectContaining({ onProgress: expect.any(Function) }),
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
      { signal: expect.any(AbortSignal) },
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
      { signal: expect.any(AbortSignal) },
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
it.each(["save", "failure", "skip"])(
  "keeps proof pending until a successful save: %s",
  async (kind) => {
    const { TaskUpdateDialog } = await import("./task-update-dialog.js");
    const dialog = /** @type {any} */ (new TaskUpdateDialog());
    dialog._render = vi.fn();
    dialog.dispatchEvent = vi.fn();
    dialog.querySelector = vi.fn(() => null);
    dialog.querySelectorAll = vi.fn(() => []);
    dialog.openResults({ taskId: "task-1", status: "completed" });
    dialog._noteDrafts = [" Work completed ", "", ""];
    dialog._uploadFiles = vi.fn().mockResolvedValue([]);
    api.createTaskUpdate.mockReset();
    api.documentTaskUpdate.mockClear();
    if (kind === "failure")
      api.createTaskUpdate.mockRejectedValue(new Error("offline"));
    else
      api.createTaskUpdate.mockResolvedValue({
        task: { proofAddedAt: "2026-10-28" },
      });
    if (kind === "skip") await dialog._close(true);
    else await dialog._saveNotes(dialog);
    expect(api.documentTaskUpdate).not.toHaveBeenCalled();
    expect(dialog._open).toBe(kind === "failure");
    if (kind === "skip") expect(api.createTaskUpdate).not.toHaveBeenCalled();
    else
      expect(api.createTaskUpdate).toHaveBeenCalledWith(
        "task-1",
        { type: "resolution_proof", notes: ["Work completed"], photoKeys: [] },
        expect.any(String),
        expect.any(Object),
      );
    if (kind === "failure")
      expect(dialog._noteDrafts[0]).toBe(" Work completed ");
    else if (kind === "save") expect(dialog._task.proofAddedAt).toBeTruthy();
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
    expect(api.documentTaskUpdate).toHaveBeenCalledWith(
      "task-1",
      "action-1",
      {
        notes: [],
        photoKeys: skip ? [] : ["photo-1"],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(dialog._pendingEvent).toBeNull();
    expect(dialog._actionText).toBe("");
    expect(dialog._load).toHaveBeenCalledOnce();
    expect(dialog._notifyUpdated).toHaveBeenCalledOnce();
  },
);

it("asks before discarding a results draft on close, without marking proof complete", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = /** @type {any} */ (new TaskUpdateDialog());
  dialog._render = vi.fn();
  dialog._showDiscard = vi.fn();
  dialog.dispatchEvent = vi.fn();
  const modal = { close: vi.fn(), querySelectorAll: () => [] };
  dialog.querySelector = vi.fn(() => modal);
  dialog.openResults({ taskId: "task-1", latestUpdateId: "update-1" });
  dialog._noteDrafts = ["Keep this note", "", ""];
  dialog._files = [{ name: "pile.jpg" }];
  dialog._uploadFile = vi.fn();
  api.documentTaskUpdate.mockReset().mockResolvedValue({ update: {} });
  await dialog._close();
  expect(dialog._showDiscard).toHaveBeenCalledOnce();
  expect(dialog._open).toBe(true);
  expect(api.documentTaskUpdate).not.toHaveBeenCalled();
  await dialog._close(true);
  expect(dialog._open).toBe(false);
  expect(api.documentTaskUpdate).not.toHaveBeenCalled();
  expect(dialog._uploadFile).not.toHaveBeenCalled();
});

it.each(["Followed up"])(
  "records action before documentation: %s",
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
    const type = "additional_action_resolved";
    await dialog._recordOutcome({ querySelectorAll: () => [] }, type, text);
    expect(api.createTaskUpdate).toHaveBeenCalledWith(
      "task-1",
      {
        type,
        text,
      },
      expect.any(String),
      { signal: expect.any(AbortSignal) },
    );
    expect(dialog._pendingEvent.updateId).toBe("update-1");
    expect(dialog._mode).toBe("action-photos");
  },
);

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
  expect(dialog._pendingEvent).toEqual({});

  await dialog.open(ticket, "action");
  expect(dialog._results).toBe(false);
  expect(dialog._editorOnly).toBe(true);
  expect(dialog._pendingEvent).toBeNull();
  expect(dialog._cityHelpNeeded).toBeNull();
  expect(dialog._content()).toContain("data-city-help");
  expect(dialog._content()).not.toContain("data-action-outcome");
});

describe("City status in issue timeline", () => {
  it("loads current closure and City events, without duplicate events on pagination", async () => {
    await import("./task-update-dialog.js");
    const Dialog = /** @type {any} */ (
      vi
        .mocked(customElements.define)
        .mock.calls.find(([name]) => name === "task-update-dialog")[1]
    );
    const dialog = new Dialog();
    dialog._render = vi.fn();
    const task = {
      taskId: "129",
      status: "in_progress",
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: { tickets: [{ srNum: "LOCAL-147" }] },
        },
      ],
    };
    const event = {
      kind: "resolved",
      title: "Resolved",
      closureReason: "Field Work Completed",
      occurredAt: "2026-10-22T21:17:24Z",
    };
    api.getTaskUpdates.mockResolvedValue({
      task,
      updates: [
        {
          type: "311_ticket_filed",
          label: "311 ticket filed",
          occurredAt: "2026-10-22T20:59:33Z",
        },
      ],
      nextToken: null,
    });
    api.get311RequestDetails.mockResolvedValue({
      requests: [
        {
          taskId: "129",
          request: {
            status: "Closed",
            closedReason: "8",
            events: [{ kind: "submitted" }, event, event],
          },
        },
      ],
    });
    await dialog.open({ ...task, ticketStatus: "On hold" });
    await vi.waitFor(() => expect(dialog._task.ticketStatus).toBe("Closed"));
    expect(dialog._task.ticketClosedReason).toBe("8");
    expect(dialog._cityUpdates).toHaveLength(1);
    expect(dialog._content()).toContain('data-status-ticker="cityClosed"');
    expect(dialog._content()).toContain("Field Work Completed");
    await dialog._load("older");
    expect(dialog._cityUpdates).toHaveLength(1);
  });
  it("keeps app activity and the last known ticker if the City feed is unavailable", async () => {
    await import("./task-update-dialog.js");
    const Dialog = /** @type {any} */ (
      vi
        .mocked(customElements.define)
        .mock.calls.find(([name]) => name === "task-update-dialog")[1]
    );
    const dialog = new Dialog();
    dialog._render = vi.fn();
    const task = {
      taskId: "129",
      status: "in_progress",
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: { tickets: [{ srNum: "LOCAL-147" }] },
        },
      ],
    };
    api.getTaskUpdates.mockResolvedValue({
      task,
      updates: [{ label: "Saved note", text: "Local activity" }],
    });
    api.get311RequestDetails.mockRejectedValue(new Error("unavailable"));
    await dialog.open({ ...task, ticketStatus: "On hold" });
    expect(dialog._state).toBe("ready");
    expect(dialog._task.ticketStatus).toBe("On hold");
    expect(dialog._detail.updates[0].text).toBe("Local activity");
  });
});

it("resolves immediately without opening documentation", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  /** @type {(value: any) => void} */
  let finish = () => {};
  api.createTaskUpdate.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  dialog.openResults = vi.fn();
  dialog._notifyUpdated = vi.fn();
  const task = { taskId: "resolve-now", status: "in_progress" };
  dialog.dispatchEvent ||= vi.fn();
  dialog.markResolved(task);
  dialog.markResolved(task);
  expect(api.createTaskUpdate).toHaveBeenLastCalledWith("resolve-now", {
    type: "issue_resolved",
  });
  expect(dialog.openResults).not.toHaveBeenCalled();
  dialog._dismiss = vi.fn();
  expect(dialog._notifyUpdated).not.toHaveBeenCalled();
  finish({
    task: { ...task, status: "completed" },
    update: { updateId: "resolved-event" },
  });
  await vi.waitFor(() => expect(dialog._dismiss).toHaveBeenCalledOnce());
  expect(dialog._notifyUpdated).toHaveBeenCalledOnce();
});

it("identifies a dismissed resolution prompt so its controller is not reused during background saves", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  dialog._results = true;
  dialog._resetDraft = vi.fn();
  dialog.querySelector = vi.fn(() => null);
  dialog.dispatchEvent = vi.fn();
  dialog._dismiss();
  const closed = vi.mocked(dialog.dispatchEvent).mock.calls[0][0];
  expect(closed.type).toBe("taskupdateclosed");
  expect(/** @type {CustomEvent} */ (closed).detail).toEqual({ results: true });
});

it("includes the confirmed task in update notifications", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  dialog._task = { taskId: "resolved", status: "completed" };
  dialog.dispatchEvent = vi.fn();
  dialog._notifyUpdated();
  expect(
    /** @type {CustomEvent} */ (
      vi.mocked(dialog.dispatchEvent).mock.calls[0][0]
    ).detail,
  ).toEqual({
    task: dialog._task,
  });
});

it("lets the worklist own timeline resolution and its card exit lifecycle", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  const task = { taskId: "timeline", status: "in_progress" };
  dialog.dispatchEvent = vi.fn(() => false);
  const calls = api.createTaskUpdate.mock.calls.length;
  dialog.markResolved(task);
  expect(dialog.dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "taskresolve",
      cancelable: true,
      detail: task,
    }),
  );
  expect(api.createTaskUpdate.mock.calls.length).toBe(calls);
});

describe("timeline loading resilience", () => {
  async function makeDialog() {
    await import("./task-update-dialog.js");
    const Dialog = /** @type {any} */ (
      vi
        .mocked(customElements.define)
        .mock.calls.find(([name]) => name === "task-update-dialog")[1]
    );
    const dialog = new Dialog();
    dialog._render = vi.fn();
    return dialog;
  }
  const task = {
    taskId: "history-resilience",
    checkId: "check",
    status: "completed",
    appActionResults: [
      { code: "create_311_ticket", payload: { tickets: [{ srNum: "local" }] } },
    ],
  };

  it("shows core activity and available photos while City and other photos are stalled", async () => {
    vi.useFakeTimers();
    try {
      const dialog = await makeDialog();
      api.getTaskUpdates.mockResolvedValue({
        task,
        updates: [{ text: "Saved activity", photoKeys: ["slow", "ready"] }],
      });
      api.get311RequestDetails.mockImplementation(() => new Promise(() => {}));
      api.getMediaUrl.mockImplementation((_check, id) =>
        id === "slow"
          ? new Promise(() => {})
          : Promise.resolve({ downloadUrl: "https://example.com/photo.jpg" }),
      );
      await dialog.open(task);
      expect(dialog._state).toBe("ready");
      expect(dialog._detail.updates[0].text).toBe("Saved activity");
      await vi.advanceTimersByTimeAsync(0);
      expect(dialog._mediaUrls.get("ready")).toBe(
        "https://example.com/photo.jpg",
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(dialog._state).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a core read and retries without accepting the late original response", async () => {
    vi.useFakeTimers();
    try {
      const dialog = await makeDialog();
      /** @type {(value: any) => void} */
      let finish = () => {};
      api.getTaskUpdates.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const opening = dialog.open({ taskId: "old" });
      expect(dialog._state).toBe("loading");
      await vi.advanceTimersByTimeAsync(15_000);
      await opening;
      expect(dialog._state).toBe("error");
      api.getTaskUpdates.mockResolvedValueOnce({
        task: { taskId: "old" },
        updates: [{ text: "Retry succeeded" }],
      });
      await dialog._load();
      finish({ task: { taskId: "old" }, updates: [{ text: "Stale" }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(dialog._state).toBe("ready");
      expect(dialog._detail.updates[0].text).toBe("Retry succeeded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replace an editor when optional photos arrive", async () => {
    const dialog = await makeDialog();
    /** @type {(value: any) => void} */
    let finish = () => {};
    api.getTaskUpdates.mockResolvedValueOnce({
      task: { taskId: "editor", checkId: "check" },
      updates: [{ photoKeys: ["photo"] }],
    });
    api.getMediaUrl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await dialog.open({ taskId: "editor" });
    dialog._mode = "note-text";
    dialog._render.mockClear();
    finish({ downloadUrl: "https://example.com/photo.jpg" });
    await vi.waitFor(() => expect(dialog._mediaUrls.has("photo")).toBe(true));
    expect(dialog._render).not.toHaveBeenCalled();
  });

  it("ignores optional responses from a previously opened issue", async () => {
    const dialog = await makeDialog();
    /** @type {(value: any) => void} */
    let finish = () => {};
    api.getTaskUpdates.mockResolvedValueOnce({ task, updates: [] });
    api.get311RequestDetails.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await dialog.open(task);
    api.getTaskUpdates.mockResolvedValueOnce({
      task: { taskId: "new" },
      updates: [],
    });
    await dialog.open({ taskId: "new" });
    finish({
      requests: [
        {
          taskId: task.taskId,
          request: { status: "Closed", events: [{ kind: "resolved" }] },
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog._task.taskId).toBe("new");
    expect(dialog._cityUpdates).toEqual([]);
  });
  it("retries the failed older page without discarding loaded pages", async () => {
    const dialog = await makeDialog();
    api.getTaskUpdates.mockResolvedValueOnce({
      task: { taskId: "pages" },
      updates: [{ updateId: "one" }],
      nextToken: "page2",
    });
    await dialog.open({ taskId: "pages" });
    api.getTaskUpdates.mockResolvedValueOnce({
      task: { taskId: "pages" },
      updates: [{ updateId: "two" }],
      nextToken: "page3",
    });
    await dialog._load(dialog._nextToken);
    api.getTaskUpdates.mockRejectedValueOnce(new Error("offline"));
    await dialog._load(dialog._nextToken);
    expect(dialog._state).toBe("error");
    expect(dialog._retryToken).toBe("page3");
    api.getTaskUpdates.mockResolvedValueOnce({
      task: { taskId: "pages" },
      updates: [{ updateId: "three" }],
      nextToken: null,
    });
    await dialog._load(dialog._retryToken);
    expect(dialog._detail.updates.map((u) => u.updateId)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("aborts stalled core reads on timeout and when switching issues", async () => {
    vi.useFakeTimers();
    try {
      const dialog = await makeDialog();
      api.getTaskUpdates.mockImplementation(() => new Promise(() => {}));
      const first = dialog.open({ taskId: "first" });
      const signal = api.getTaskUpdates.mock.calls.at(-1)[2].signal;
      await vi.advanceTimersByTimeAsync(15000);
      await first;
      expect(signal.aborted).toBe(true);
      const second = dialog._load();
      const secondSignal = api.getTaskUpdates.mock.calls.at(-1)[2].signal;
      api.getTaskUpdates.mockResolvedValueOnce({
        task: { taskId: "new" },
        updates: [],
      });
      await dialog.open({ taskId: "new" });
      await second;
      expect(secondSignal.aborted).toBe(true);
      expect(dialog._task.taskId).toBe("new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts optional reads and cancels queued rendering on dismissal", async () => {
    const dialog = await makeDialog();
    api.getTaskUpdates.mockResolvedValueOnce({
      task,
      updates: [{ photoKeys: ["pending"] }],
    });
    api.get311RequestDetails.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    api.getMediaUrl.mockImplementationOnce(() => new Promise(() => {}));
    await dialog.open(task);
    const citySignal = api.get311RequestDetails.mock.calls.at(-1)[1].signal;
    const photoSignal = api.getMediaUrl.mock.calls.at(-1)[2].signal;
    dialog._refreshTimeline();
    dialog.querySelector = () => null;
    dialog.dispatchEvent = vi.fn();
    dialog._dismiss();
    expect(citySignal.aborted).toBe(true);
    expect(photoSignal.aborted).toBe(true);
    expect(dialog._timelineFrame).toBeNull();
  });

  it("coalesces enrichment paints and skips unchanged photo URLs", async () => {
    vi.useFakeTimers();
    try {
      const dialog = await makeDialog();
      dialog._renderTimeline = vi.fn();
      dialog._refreshTimeline();
      dialog._refreshTimeline();
      dialog._refreshTimeline();
      await vi.advanceTimersByTimeAsync(20);
      expect(dialog._renderTimeline).toHaveBeenCalledTimes(1);
      dialog._task = { checkId: "check" };
      dialog._detail = { updates: [{ photoKeys: ["same"] }] };
      dialog._mediaUrls.set("same", "url");
      api.getMediaUrl.mockResolvedValueOnce({ downloadUrl: "url" });
      await dialog._loadTimelinePhotos(dialog._loadGeneration);
      expect(dialog._timelineFrame).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("cancels a stalled upload, keeps the draft, and never saves a late result", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = /** @type {any} */ (new TaskUpdateDialog());
  dialog._task = { taskId: "cancel-task", status: "in_progress" };
  dialog._mode = "notes";
  dialog._noteDrafts = ["Keep this note", "", ""];
  dialog._showDiscard = vi.fn();
  /** @type {(photos: string[]) => void} */
  let completeUpload = () => {
    throw new Error("Upload has not started");
  };
  dialog._uploadFiles = vi.fn(
    () =>
      new Promise((resolve) => {
        completeUpload = resolve;
      }),
  );
  api.createTaskUpdate.mockClear();
  const capture = { inert: false };
  const root = {
    querySelector: (selector) =>
      selector.startsWith(".task-update__capture") ? capture : null,
    querySelectorAll: () => [],
  };
  const save = dialog._saveNotes(root);
  await vi.waitFor(() => expect(dialog._uploadFiles).toHaveBeenCalled());
  expect(capture.inert).toBe(true);
  await dialog._close();
  await save;
  expect(capture.inert).toBe(false);
  expect(dialog._noteDrafts[0]).toBe("Keep this note");
  expect(dialog._showDiscard).toHaveBeenCalledOnce();
  completeUpload?.(["late-photo"]);
  await Promise.resolve();
  expect(api.createTaskUpdate).not.toHaveBeenCalled();
});

it("times out an unresponsive save and retries with the same update identity", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = /** @type {any} */ (new TaskUpdateDialog());
  dialog._task = { taskId: "timeout-task", status: "in_progress" };
  dialog._mode = "notes";
  dialog._noteDrafts = ["Keep this note", "", ""];
  dialog._finishSave = vi.fn();
  api.createTaskUpdate
    .mockReset()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue({});
  toasts.showTaskUpdateErrorToast.mockClear();
  const root = { querySelector: () => null, querySelectorAll: () => [] };
  vi.useFakeTimers();
  try {
    const save = dialog._saveNotes(root);
    await vi.advanceTimersByTimeAsync(120_000);
    await save;
    expect(dialog._busy).toBe(false);
    expect(toasts.showTaskUpdateErrorToast).toHaveBeenCalledOnce();
    expect(dialog._noteDrafts[0]).toBe("Keep this note");
    await dialog._saveNotes(root);
    expect(api.createTaskUpdate.mock.calls[1][2]).toBe(
      api.createTaskUpdate.mock.calls[0][2],
    );
    expect(dialog._finishSave).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("allows local updates without a City-help choice when the API reports only closed tickets", async () => {
  const { TaskUpdateDialog } = await import("./task-update-dialog.js");
  const dialog = new TaskUpdateDialog();
  dialog._render = vi.fn();
  dialog._loadCityUpdates = vi.fn();
  dialog._loadTimelinePhotos = vi.fn();
  api.getTaskUpdates.mockResolvedValueOnce({
    task: { canUpdate: true, canRequestCityHelp: false },
    updates: [],
  });
  await dialog.open(
    {
      taskId: "closed-city-ticket",
      status: "in_progress",
      appActionResults: [
        { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
      ],
    },
    "notes",
  );
  expect(dialog._cityHelpNeeded).toBeUndefined();
  expect(dialog._content()).not.toContain("data-city-help");
  dialog._resetDraft();
  expect(dialog._cityHelpNeeded).toBeUndefined();
});
