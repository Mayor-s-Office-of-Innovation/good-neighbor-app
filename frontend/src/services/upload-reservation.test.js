import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ getUploadRequestId: vi.fn() }));
import { getUploadRequestId } from "../db.js";
import { reserveMediaUpload } from "./upload-reservation.js";
beforeEach(() =>
  vi.mocked(getUploadRequestId).mockReset().mockResolvedValue("saved-id"),
);
it("awaits durable identity before presigning", async () => {
  /** @type {(value: string) => void} */
  let release = () => {
    throw new Error("Storage request was not started");
  };
  vi.mocked(getUploadRequestId).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const presign = vi.fn().mockResolvedValue({ artifactId: "server-id" });
  const pending = reserveMediaUpload("check:1", new Blob(["photo"]), presign);
  await vi.waitFor(() => expect(getUploadRequestId).toHaveBeenCalledOnce());
  expect(presign).not.toHaveBeenCalled();
  release("saved-id");
  expect(await pending).toEqual({ artifactId: "server-id" });
  expect(presign).toHaveBeenCalledWith("saved-id");
});
it("keeps identity on uncertain failures", async () => {
  const error = { status: 0 };
  const presign = vi.fn().mockRejectedValue(error);
  await expect(
    reserveMediaUpload("check:1", new Blob(["photo"]), presign),
  ).rejects.toBe(error);
  expect(getUploadRequestId).toHaveBeenCalledTimes(1);
});
it("rotates only the ID rejected as expired and retries once", async () => {
  vi.mocked(getUploadRequestId)
    .mockResolvedValueOnce("expired-id")
    .mockResolvedValueOnce("new-id");
  const presign = vi
    .fn()
    .mockRejectedValueOnce({ status: 410, body: { error: "upload_expired" } })
    .mockResolvedValueOnce({ artifactId: "new-artifact" });
  await reserveMediaUpload("check:1", new Blob(["photo"]), presign);
  expect(getUploadRequestId).toHaveBeenLastCalledWith(
    "check:1",
    expect.any(String),
    "expired-id",
  );
  expect(presign.mock.calls).toEqual([["expired-id"], ["new-id"]]);
});
it("does not send if durable storage fails", async () => {
  vi.mocked(getUploadRequestId).mockRejectedValueOnce(
    new Error("storage unavailable"),
  );
  const presign = vi.fn();
  await expect(
    reserveMediaUpload("check:1", new Blob(["photo"]), presign),
  ).rejects.toThrow("storage unavailable");
  expect(presign).not.toHaveBeenCalled();
});
it("changes the fingerprint for changed bytes or type", async () => {
  const presign = vi.fn().mockResolvedValue({});
  for (const blob of [
    new Blob(["one"], { type: "image/jpeg" }),
    new Blob(["two"], { type: "image/jpeg" }),
    new Blob(["one"], { type: "image/png" }),
  ])
    await reserveMediaUpload("check:1", blob, presign);
  expect(
    new Set(vi.mocked(getUploadRequestId).mock.calls.map((args) => args[1]))
      .size,
  ).toBe(3);
});
