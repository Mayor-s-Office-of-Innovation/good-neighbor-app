import { beforeAll, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  uploadTaskUpdatePhoto: vi.fn(),
}));
const toasts = vi.hoisted(() => ({
  showTaskUpdateErrorToast: vi.fn(),
}));
vi.mock("../services/api.js", () => ({
  ApiError: class ApiError extends Error {},
  createTaskUpdate: vi.fn(),
  documentTaskUpdate: vi.fn(),
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
    dialog._showDiscardConfirmation = vi.fn();
    dialog._sealPendingEvent = vi.fn();
    dialog._resetDraft = vi.fn();
    dialog._load = vi.fn();

    await dialog._close();
    expect(dialog._showDiscardConfirmation).toHaveBeenCalledOnce();
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
    dialog._readFile = vi.fn().mockResolvedValue("data:image/jpeg;base64,AA==");
    api.uploadTaskUpdatePhoto.mockResolvedValue({ artifactId: "photo-1" });

    await expect(dialog._uploadFile(file)).resolves.toBe("photo-1");
    await expect(dialog._uploadFile(file)).resolves.toBe("photo-1");
    expect(api.uploadTaskUpdatePhoto).toHaveBeenCalledTimes(1);
  });
});
