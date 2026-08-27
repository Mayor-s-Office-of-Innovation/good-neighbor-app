// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  image.js — small client-side image helpers.

  Currently just a thumbnail downscaler. Once a photo's full-resolution bytes are
  safely in S3 (services/artifact-uploader.js), the draft keeps only a thumbnail
  instead of the full base64: this bounds IndexedDB growth on many-photo walks and
  is all the results evidence strip needs to render (components/check-results.js,
  check-review.js render item.dataUrl directly).
*/

/**
 * Load a data URL into an HTMLImageElement. Resolves null (never rejects) so the
 * caller can fall back to the original bytes rather than lose a capture.
 * @param {string} src
 * @returns {Promise<HTMLImageElement|null>}
 */
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Downscale a JPEG/PNG data URL to a small thumbnail data URL via an offscreen
 * canvas. Never upscales. Falls back to the original data URL if the image can't
 * be decoded or a canvas isn't available (better a large thumb than a broken one).
 * @param {string} dataUrl
 * @param {{ maxDim?: number, quality?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function downscaleDataUrl(
  dataUrl,
  { maxDim = 640, quality = 0.6 } = {},
) {
  const img = await loadImage(dataUrl);
  if (!img || !img.width || !img.height) return dataUrl;

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  ctx.drawImage(img, 0, 0, dw, dh);
  return canvas.toDataURL("image/jpeg", quality);
}
