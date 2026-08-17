// Image downscale seam for the analyze worker. The worker calls this before
// base64-encoding media for the analyzer; keeping it behind a function lets the
// worker inject a stub in tests and lets us swap the real implementation in
// without touching the worker.

/**
 * @typedef {object} DownscaleResult
 * @property {Buffer} bytes
 * @property {string} contentType
 */

/**
 * Fit an image within the analyzer's max working size before encoding.
 *
 * PLACEHOLDER PASSTHROUGH (Step C): returns the input unchanged. The real
 * implementation (Step E/F) uses `sharp` to fit the long edge within 1568px and
 * re-encode to JPEG — deferred because sharp's native binary is a Lambda
 * packaging concern and the Step D stub analyzer doesn't need real downscaling.
 * @param {Buffer} bytes
 * @param {string} contentType
 * @returns {Promise<DownscaleResult>}
 */
export async function downscaleImage(bytes, contentType) {
  // TODO(step E/F): sharp resize to long-edge <= 1568px, re-encode JPEG.
  return { bytes, contentType };
}
