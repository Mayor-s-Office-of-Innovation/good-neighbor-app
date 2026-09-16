import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { downscaleImage } from "./downscale.js";

/** Make a real JPEG of the given dimensions so sharp has real pixels to work. */
const jpegOf = (/** @type {number} */ width, /** @type {number} */ height) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 60, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();

describe("downscaleImage", () => {
  it("fits an oversized image within the 1568px long edge as JPEG", async () => {
    const bytes = await jpegOf(4000, 3000);
    const result = await downscaleImage(bytes, "image/jpeg");
    expect(result.contentType).toBe("image/jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width, meta.height)).toBe(1568);
    // 4000x3000 → 1568x1176
    expect(meta.width).toBe(1568);
    expect(meta.height).toBe(1176);
  });

  it("keeps the long edge at 1568px for portrait input", async () => {
    const bytes = await jpegOf(3000, 4000);
    const result = await downscaleImage(bytes, "image/jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(1176);
    expect(meta.height).toBe(1568);
  });

  it("never enlarges a small image", async () => {
    const bytes = await jpegOf(640, 480);
    const result = await downscaleImage(bytes, "image/jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it("applies EXIF orientation and reports upright dimensions", async () => {
    // Real camera photos carry an EXIF Orientation tag (e.g. 6 = rotate 90° CW
    // for display). sharp's `withExif` refuses to persist a non-default
    // Orientation reliably, so build one by hand: a JPEG with a minimal APP1
    // EXIF segment whose IFD0 holds Orientation=6. Stored pixels are 100x200
    // portrait; the tag says "rotate to view" — `.rotate()` must bake that.
    const base = await sharp({
      create: { width: 100, height: 200, channels: 3, background: "#333" },
    })
      .jpeg()
      .toBuffer();
    const tiff = Buffer.alloc(26);
    tiff.write("II", 0, "ascii"); // little-endian TIFF
    tiff.writeUInt16LE(42, 2); // magic
    tiff.writeUInt32LE(8, 4); // IFD0 offset
    tiff.writeUInt16LE(1, 8); // one entry
    tiff.writeUInt16LE(0x0112, 10); // Orientation tag id
    tiff.writeUInt16LE(3, 12); // type SHORT
    tiff.writeUInt32LE(1, 14); // count 1
    tiff.writeUInt16LE(6, 18); // Orientation = 6 (rotate 90° CW)
    const exif = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
    const seg = Buffer.alloc(4 + exif.length);
    seg[0] = 0xff;
    seg[1] = 0xe1; // APP1 marker
    seg.writeUInt16BE(exif.length + 2, 2);
    exif.copy(seg, 4);
    const tagged = Buffer.concat([base.subarray(0, 2), seg, base.subarray(2)]);
    expect((await sharp(tagged).metadata()).orientation).toBe(6);

    const result = await downscaleImage(tagged, "image/jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.orientation).toBeUndefined(); // tag consumed, pixels upright
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });

  it("re-encodes PNG input to JPEG", async () => {
    const bytes = await sharp({
      create: { width: 2000, height: 1000, channels: 4, background: "#0f0" },
    })
      .png()
      .toBuffer();
    const result = await downscaleImage(bytes, "image/png");
    expect(result.contentType).toBe("image/jpeg");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width, meta.height)).toBe(1568);
  });

  it("bounds the output payload well under the analyzer's tolerance", async () => {
    const bytes = await jpegOf(6000, 4500);
    const result = await downscaleImage(bytes, "image/jpeg");
    // A solid-color worst case is tiny; assert a generous ceiling so the test
    // stays meaningful for noisy photos too.
    expect(result.bytes.length).toBeLessThan(1_000_000);
  });
});
