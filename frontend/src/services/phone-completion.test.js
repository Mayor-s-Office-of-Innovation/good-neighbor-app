import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("./api.js", () => ({ completeTask: vi.fn() }));
vi.mock("../db.js", () => ({ getSite: vi.fn() }));
vi.mock("../state/toasts.js", () => ({
  showActionSaveErrorToast: vi.fn(() => ({ close: vi.fn() })),
}));
import { completeTask } from "./api.js";
import { getSite } from "../db.js";
import { showActionSaveErrorToast } from "../state/toasts.js";
let storage, service;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    get length() {
      return storage.size;
    },
    key: (i) => [...storage.keys()][i],
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.mocked(getSite).mockResolvedValue({ siteId: "site" });
  vi.mocked(completeTask).mockResolvedValue({
    task: { status: "in_progress" },
  });
  service = await import("./phone-completion.js");
});
afterEach(() => vi.unstubAllGlobals());

it("persists before async preparation and deduplicates concurrent saves", async () => {
  let finish = (value) => {
    void value;
  };
  vi.mocked(completeTask).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const saving = service.savePhoneCompletion("task", "site");
  expect(storage.size).toBe(1);
  const duplicate = service.savePhoneCompletion("task", "site");
  await service.recoverPhoneCompletions();
  expect(completeTask).toHaveBeenCalledTimes(1);
  expect(completeTask).toHaveBeenCalledWith(
    "task",
    { completionMethod: "manual" },
    { originSiteId: "site", signal: expect.any(AbortSignal) },
  );
  finish({ task: { status: "in_progress" } });
  await Promise.all([saving, duplicate]);
  expect(storage.size).toBe(0);
});

it("recovers after reload and keeps other sites untouched", async () => {
  storage.set(
    "gnp:phone-completion:other:task",
    JSON.stringify({ siteId: "other", taskId: "task" }),
  );
  storage.set(
    "gnp:phone-completion:site:task",
    JSON.stringify({ siteId: "site", taskId: "task" }),
  );
  await service.recoverPhoneCompletions();
  expect(completeTask).toHaveBeenCalledTimes(1);
  expect(storage.size).toBe(1);
  expect(window.dispatchEvent).toHaveBeenCalledOnce();
});

it("keeps failed saves and provides a retry without another phone handoff", async () => {
  vi.mocked(completeTask).mockRejectedValueOnce(new Error("offline"));
  await expect(service.savePhoneCompletion("task", "site")).rejects.toThrow(
    "offline",
  );
  expect(storage.size).toBe(1);
  expect(showActionSaveErrorToast).toHaveBeenCalledWith(expect.any(Function));
  await service.recoverPhoneCompletions();
  expect(storage.size).toBe(0);
  expect(completeTask).toHaveBeenCalledTimes(2);
});

it("still saves with storage unavailable", async () => {
  vi.stubGlobal("sessionStorage", {
    setItem() {
      throw new Error("denied");
    },
  });
  await expect(
    service.savePhoneCompletion("task", "site"),
  ).resolves.toMatchObject({ task: { status: "in_progress" } });
});
