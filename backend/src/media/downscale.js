// Image downscale seam for the analyze worker. The worker calls this before
// base64-encoding media for the analyzer; keeping it behind a function lets the
// worker inject a stub in tests and lets us swap the real implementation in
// without touching the worker.
//
// Implementation notes:
// - `.rotate()` with no args applies the EXIF orientation tag (camera photos
//   carry it) and strips the tag, so the analyzer sees upright pixels.
// - Long edge ≤ 1568px matches the analyzer's documented working size; larger
//   inputs are pure upload cost and were rejected outright (413
//   `input_too_large`) at full camera resolution before this existed.
// - Re-encode to JPEG q80 normalizes HEIC-adjacent camera output to something
//   the analyzer accepts and bounds the base64 payload (< ~1 MB typical).

import sharp from "sharp";

/**
 * @typedef {object} DownscaleResult
 * @property {Buffer} bytes
 * @property {string} contentType
 */

/** Long-edge cap fed to the analyzer (px). */
const MAX_EDGE_PX = 1568;
/** JPEG re-encode quality. */
const JPEG_QUALITY = 80;

/**
 * Fit an image within the analyzer's max working size before encoding.
 * Always emits JPEG (the analyzer's baseline type); small images pass through
 * the resize untouched (`withoutEnlargement`).
 * @param {Buffer} bytes
 * @param {string} contentType
 * @returns {Promise<DownscaleResult>}
 */
export async function downscaleImage(bytes, contentType) {
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize({
      width: MAX_EDGE_PX,
      height: MAX_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    contentType: info.format === "jpeg" ? "image/jpeg" : contentType,
  };
}
