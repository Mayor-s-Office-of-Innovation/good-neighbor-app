import { readFile } from "node:fs/promises";
import { expect, it, vi, beforeEach } from "vitest";
import sharp from "sharp";
const { getObjectBytes, putObject } = vi.hoisted(() => ({
  getObjectBytes: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock("../s3.js", () => ({ getObjectBytes, putObject }));
import {
  heicDisplayImage,
  InvalidTaskPhoto,
  storeTaskPhotoDisplay,
} from "./task-photo.js";
const fixture = () =>
  readFile(new URL("./fixtures/synthetic.heic", import.meta.url));
beforeEach(() => {
  getObjectBytes.mockReset();
  putObject.mockReset();
});
it("converts real HEVC pixels to a browser-compatible JPEG", async () => {
  const jpeg = await heicDisplayImage(await fixture());
  const meta = await sharp(jpeg).metadata();
  expect(meta).toMatchObject({
    format: "jpeg",
    width: 48,
    height: 32,
    channels: 3,
  });
  const stats = await sharp(jpeg).stats();
  expect(stats.channels[0].mean).toBeCloseTo(68, -1);
  expect(stats.channels[1].mean).toBeCloseTo(119, -1);
  expect(stats.channels[2].mean).toBeCloseTo(170, -1);
});
it("rejects invalid or oversized data", async () => {
  await expect(heicDisplayImage(Buffer.from("invalid"))).rejects.toBeInstanceOf(
    InvalidTaskPhoto,
  );
  await expect(
    heicDisplayImage(Buffer.alloc(10 * 1024 * 1024 + 1)),
  ).rejects.toBeInstanceOf(InvalidTaskPhoto);
});
it("stores a sibling rendition without replacing the original", async () => {
  const bytes = await fixture();
  getObjectBytes.mockResolvedValue({ bytes, contentType: "image/heic" });
  const key = "checks/site/check/photo";
  expect(
    await storeTaskPhotoDisplay({
      bucket: "uploads",
      key,
      contentType: "image/heic",
      contentLength: bytes.length,
    }),
  ).toBe(`${key}.display.jpg`);
  expect(putObject).toHaveBeenCalledWith(
    expect.objectContaining({
      bucket: "uploads",
      key: `${key}.display.jpg`,
      contentType: "image/jpeg",
      tagging: "state=registered",
    }),
  );
  expect(
    await storeTaskPhotoDisplay({
      bucket: "uploads",
      key,
      contentType: "image/jpeg",
      contentLength: bytes.length,
    }),
  ).toBeUndefined();
  expect(getObjectBytes).toHaveBeenCalledTimes(1);
});
it("rejects changed upload metadata before saving a rendition", async () => {
  getObjectBytes.mockResolvedValue({
    bytes: await fixture(),
    contentType: "image/jpeg",
  });
  await expect(
    storeTaskPhotoDisplay({
      bucket: "uploads",
      key: "checks/site/check/photo",
      contentType: "image/heic",
      contentLength: 1,
    }),
  ).rejects.toBeInstanceOf(InvalidTaskPhoto);
  expect(putObject).not.toHaveBeenCalled();
});
