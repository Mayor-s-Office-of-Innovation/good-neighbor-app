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
// - `sharp` is imported lazily, on first use. The api Lambda bundles this
//   module through care-work.js and guidance/app-actions.js, so a static
//   import loaded the native libvips addon on EVERY api cold start — on the
//   order of 100–300 ms at 512 MB — although only two routes ever downscale.
//   The dynamic import resolves once per container (module cache); the
//   worker, which always downscales, pays the same cost it did before.

/** @type {Promise<typeof import("sharp").default> | undefined} */
let sharpModule;

/**
 * Load sharp on first use (see the header note).
 * @returns {Promise<typeof import("sharp").default>}
 */
function loadSharp() {
  sharpModule ??= import("sharp").then((m) => m.default);
  return sharpModule;
}

/**
 * A permanent downscale failure: the bytes are not a decodable image. Maps to
 * the worker's terminal failed-marker path (like `input_too_large`), never a
 * redelivery.
 */
export class DownscaleError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "undecodable_input") {
    super(message);
    this.code = code;
  }
}

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
  heif: "image/heic",
};
/** ISO-BMFF major brands for HEIC/HEIF still images (phones use these). */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/**
 * Identify an allowed image type from its leading bytes, before any decoder
 * sees them. sharp picks its decoder from the bytes, not the declared type, so
 * without this an SVG (or any other libvips format) labeled `image/jpeg` would
 * be parsed by that format's library. Only the four types we accept get past.
 * @param {Buffer} bytes
 * @returns {string | undefined} the matching content type, if any
 */
export function sniffImageType(bytes) {
  const ascii = (/** @type {number} */ start, /** @type {number} */ end) =>
    bytes.subarray(start, end).toString("latin1");
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12)))
    return "image/heic";
  return undefined;
}

/**
 * Whether a detected type agrees with the uploader's declared type.
 * @param {string | undefined} detectedType
 * @param {string} contentType
 * @returns {boolean}
 */
function typeMatches(detectedType, contentType) {
  return (
    detectedType === contentType ||
    (detectedType === "image/heic" && contentType === "image/heif")
  );
}

/**
 * Fit an image within the analyzer's max working size before encoding.
 * Always emits JPEG (the analyzer's baseline type); small images pass through
 * the resize untouched (`withoutEnlargement`).
 * @param {Buffer} bytes
 * @param {string} contentType
 * @returns {Promise<DownscaleResult>}
 */
export async function downscaleImage(bytes, contentType) {
  // Outside the try: a sharp load failure (missing platform binary in the
  // zip) is an infrastructure fault that must surface as an error, never as
  // a permanent "undecodable image" rejection of the upload.
  const sharp = await loadSharp();
  let result;
  try {
    // Check the file signature before sharp parses anything (see sniffImageType).
    const sniffedType = sniffImageType(bytes);
    if (!sniffedType || !typeMatches(sniffedType, contentType)) {
      throw new DownscaleError(
        `Undecodable image input (${contentType}): file signature ${sniffedType ?? "unrecognized"}`,
        sniffedType ? "image_type_mismatch" : "undecodable_input",
      );
    }
    const input = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
      pages: 1,
    });
    const metadata = await input.metadata();
    const detectedType = TYPE_BY_FORMAT[metadata.format];
    if (!detectedType || !typeMatches(detectedType, contentType)) {
      throw new DownscaleError(
        `Undecodable image input (${contentType}): declared type ${contentType} does not match decoded type ${detectedType ?? "unknown"}`,
        detectedType ? "image_type_mismatch" : "undecodable_input",
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
    if (err instanceof DownscaleError) throw err;
    throw new DownscaleError(
      `Undecodable image input (${contentType}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    bytes: result.data,
    contentType: "image/jpeg",
  };
}
