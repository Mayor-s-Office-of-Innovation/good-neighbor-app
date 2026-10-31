// A dedicated worker owns the only full-size decode used for local previews.
// It never uploads, persists originals, or returns full-resolution pixels.
self.onmessage = async ({ data }) => {
  let bitmap;
  let canvas;
  try {
    if (
      typeof createImageBitmap !== "function" ||
      typeof OffscreenCanvas !== "function"
    ) {
      self.postMessage({ unsupported: true });
      return;
    }
    bitmap = await createImageBitmap(data.original);
    data.original = null;
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    bitmap = null;
    const preview = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.75,
    });
    self.postMessage({ preview });
  } catch {
    self.postMessage({ failed: true });
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
};
