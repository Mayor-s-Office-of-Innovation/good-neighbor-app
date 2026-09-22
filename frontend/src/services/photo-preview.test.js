import { afterEach, expect, it, vi } from "vitest";
import { createPhotoPreview } from "./photo-preview.js";
afterEach(() => vi.unstubAllGlobals());
it("creates a bounded display derivative and releases the decoded original", async () => {
  const bitmap = { width: 3000, height: 4000, close: vi.fn() };
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "" };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: vi.fn(() => "data:image/jpeg;base64,small"),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ blob: async () => new Blob() }),
  );
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  vi.stubGlobal("document", { createElement: () => canvas });
  await expect(
    createPhotoPreview("data:image/jpeg;base64,original"),
  ).resolves.toBe("data:image/jpeg;base64,small");
  expect(canvas.width).toBe(300);
  expect(canvas.height).toBe(400);
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 300, 400);
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it("falls back when preview decoding fails", async () => {
  vi.stubGlobal("document", {});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ blob: async () => new Blob() }),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockRejectedValue(new Error("Unsupported")),
  );
  await expect(
    createPhotoPreview("data:image/jpeg;base64,original"),
  ).resolves.toBeNull();
});
