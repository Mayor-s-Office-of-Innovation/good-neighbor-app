/**
 * Read a batch sequentially without cancelling earlier selected files.
 * @param {File[]} files
 * @param {() => boolean} isCurrent
 * @param {(dataUrl: string) => void} onPhoto
 */
export async function readCaptureFiles(files, isCurrent, onPhoto) {
  for (const file of files) {
    if (!isCurrent()) return;
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = reader.onabort = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!isCurrent()) return;
    if (dataUrl) onPhoto(dataUrl);
  }
}
