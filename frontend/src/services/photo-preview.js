/**
 * A display-only derivative. The caller retains the original for uploading.
 * @param {string} dataUrl
 * @returns {Promise<string | null>}
 */
export async function createPhotoPreview(dataUrl) {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  )
    return null;
  let bitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
