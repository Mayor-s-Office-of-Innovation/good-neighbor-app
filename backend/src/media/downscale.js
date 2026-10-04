// Image downscale seam for the analyze worker. The worker calls this before
// base64-encoding media for the analyzer; keeping it behind a function lets the
// worker inject a stub in tests and lets us swap the real implementation in
// without touching the worker.
//
// Implementation notes:
// - `.rotate()` with no args applies the EXIF orientation tag (camera photos
//   carry it) and strips the tag, so the analyzer sees upright pixels.
// - `.flatten({ background: white })` composites any alpha channel onto white
//   before the JPEG encoder drops it — transparent PNG/WebP uploads would
//   otherwise become opaque black (the encoder's zero-fill), materially
//   changing the image the analyzer assesses.
// - Long edge ≤ 1568px matches the analyzer's documented working size; larger
//   inputs are pure upload cost and were rejected outright (413
//   `input_too_large`) at full camera resolution before this existed.
// - Re-encode to JPEG q80 normalizes HEIC-adjacent camera output to something
//   the analyzer accepts and bounds the base64 payload (< ~1 MB typical).
// - Throws `DownscaleError` (a permanent, non-retryable condition) when the
//   bytes are not a decodable image: the worker maps that to an ANALYSIS#
//   failed marker instead of redelivering to the DLQ. Bytes can be corrupt
//   even when presign pinned an image content-type — the type is declared by
//   the uploader, never verified.

import sharp from "sharp";

/**
 * A permanent downscale failure: the bytes are not a decodable image. Maps to
 * the worker's terminal failed-marker path (like `input_too_large`), never a
 * redelivery.
 */
export class DownscaleError extends Error {}

/**
 * @typedef {object} DownscaleResult
 * @property {Buffer} bytes
 * @property {string} contentType
 */

/** Long-edge cap fed to the analyzer (px). */
const MAX_EDGE_PX = 1568;
/** JPEG re-encode quality. */
const JPEG_QUALITY = 80;
/** Matte color alpha channels composite onto before JPEG drops them. */
const FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 };
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_EDGE = 12_000;
/** @type {Record<string, string>} */
const TYPE_BY_FORMAT = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Fit an image within the analyzer's max working size before encoding.
 * Always emits JPEG (the analyzer's baseline type); small images pass through
 * the resize untouched (`withoutEnlargement`).
 * @param {Buffer} bytes
 * @param {string} contentType
 * @returns {Promise<DownscaleResult>}
 */
export async function downscaleImage(bytes, contentType) {
  let result;
  try {
    const input = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
      pages: 1,
    });
    const metadata = await input.metadata();
    const detectedType = TYPE_BY_FORMAT[metadata.format];
    if (!detectedType || detectedType !== contentType) {
      throw new Error(
        `declared type ${contentType} does not match decoded type ${detectedType ?? "unknown"}`,
      );
    }
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_INPUT_EDGE ||
      metadata.height > MAX_INPUT_EDGE ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new Error("image dimensions or page count exceed policy");
    }
    result = await input
      .rotate()
      .flatten({ background: FLATTEN_BACKGROUND })
      .resize({
        width: MAX_EDGE_PX,
        height: MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new DownscaleError(
      `Undecodable image input (${contentType}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    bytes: result.data,
    contentType: "image/jpeg",
  };
}
