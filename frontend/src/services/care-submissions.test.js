import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({
  getSite: vi.fn(),
  listCareSubmissions: vi.fn(),
  saveCareSubmission: vi.fn(),
}));
vi.mock("./api.js", () => ({
  createCareWork: vi.fn(),
  presignCarePhoto: vi.fn(),
  putMediaWithProgress: vi.fn(),
}));
vi.mock("../state/toasts.js", () => ({ showToast: vi.fn() }));
import { getSite, listCareSubmissions, saveCareSubmission } from "../db.js";
import {
  createCareWork,
  presignCarePhoto,
  putMediaWithProgress,
} from "./api.js";
let records, service;
const draft = () => ({
  siteId: "site",
  workId: "work",
  kind: "power_washed",
  note: "",
  files: [
    { photoId: "photo", file: new Blob(["photo"], { type: "image/jpeg" }) },
  ],
});
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  records = new Map();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.mocked(getSite).mockResolvedValue({ siteId: "site", deviceId: "device" });
  vi.mocked(listCareSubmissions).mockImplementation(async (site) =>
    [...records.values()]
      .filter((r) => r.siteId === site)
      .map((r) => structuredClone(r)),
  );
  vi.mocked(saveCareSubmission).mockImplementation(async (r) => {
    records.set(r.workId, structuredClone(r));
  });
  vi.mocked(presignCarePhoto).mockResolvedValue({
    photoId: "photo",
    uploadUrl: "https://upload",
    uploadHeaders: {},
  });
  vi.mocked(putMediaWithProgress).mockResolvedValue(undefined);
  vi.mocked(createCareWork).mockResolvedValue({
    work: {
      workId: "work",
      kind: "power_washed",
      note: "",
      createdAt: new Date().toISOString(),
    },
  });
  service = await import("./care-submissions.js");
});
afterEach(() => vi.unstubAllGlobals());
it("durably stores blobs and returns while uploads are still pending", async () => {
  let finish = () => {};
  vi.mocked(putMediaWithProgress).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  await service.enqueueCareSubmission(draft());
  await vi.waitFor(() => expect(putMediaWithProgress).toHaveBeenCalledOnce());
  expect(records.get("work").files[0].file.size).toBe(5);
  expect(createCareWork).not.toHaveBeenCalled();
  finish();
  await service.retryCareSubmission("work");
  expect(records.get("work").status).toBe("saved");
  expect(records.get("work").files).toEqual([]);
});
it("replays an uncertain create unchanged after reopening", async () => {
  vi.mocked(createCareWork).mockRejectedValueOnce(new Error("lost response"));
  await service.enqueueCareSubmission(draft());
  await service.retryCareSubmission("work");
  expect(records.get("work").status).toBe("failed");
  const payload = structuredClone(records.get("work").payload);
  vi.resetModules();
  service = await import("./care-submissions.js");
  await service.retryCareSubmission("work");
  expect(createCareWork).toHaveBeenLastCalledWith(
    payload,
    expect.objectContaining({ originSiteId: "site" }),
  );
  expect(putMediaWithProgress).toHaveBeenCalledOnce();
  expect(records.get("work").status).toBe("saved");
});
it("recovers a pending submission from persistent storage", async () => {
  records.set("work", {
    ...draft(),
    deviceId: "device",
    status: "pending",
    payload: null,
  });
  await service.recoverCareSubmissions();
  await service.retryCareSubmission("work");
  expect(records.get("work").status).toBe("saved");
});
it("keeps a failed upload for explicit retry", async () => {
  vi.mocked(putMediaWithProgress).mockRejectedValueOnce(new Error("offline"));
  await service.enqueueCareSubmission(draft());
  await service.retryCareSubmission("work");
  expect(records.get("work").status).toBe("failed");
  await service.recoverCareSubmissions();
  expect(putMediaWithProgress).toHaveBeenCalledOnce();
  await service.retryCareSubmission("work");
  expect(records.get("work").status).toBe("saved");
});
it("does not submit another site's or another device session's work", async () => {
  records.set("work", {
    ...draft(),
    deviceId: "old-device",
    status: "pending",
  });
  await service.retryCareSubmission("work");
  vi.mocked(getSite).mockResolvedValue({ siteId: "other", deviceId: "device" });
  await service.retryCareSubmission("work");
  expect(createCareWork).not.toHaveBeenCalled();
  expect(presignCarePhoto).not.toHaveBeenCalled();
});
it("renews an explicitly expired photo only after replaying the frozen payload", async () => {
  const payload = {
    workId: "work",
    kind: "power_washed",
    note: "",
    photoIds: ["photo"],
  };
  records.set("work", {
    ...draft(),
    deviceId: "device",
    status: "failed",
    payload,
  });
  vi.mocked(createCareWork).mockRejectedValueOnce({
    body: { error: "photo_expired", photoId: "photo" },
  });
  await service.retryCareSubmission("work");
  expect(createCareWork).toHaveBeenNthCalledWith(1, payload, expect.anything());
  expect(createCareWork).toHaveBeenCalledTimes(2);
  expect(records.get("work").payload.photoIds[0]).not.toBe("photo");
});
it("keeps the form's submission unaccepted when local storage fails", async () => {
  vi.mocked(saveCareSubmission).mockRejectedValueOnce(new Error("quota"));
  await expect(service.enqueueCareSubmission(draft())).rejects.toThrow("quota");
  expect(presignCarePhoto).not.toHaveBeenCalled();
});
