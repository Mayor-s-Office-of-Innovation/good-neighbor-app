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
      try {
        reader.readAsDataURL(file);
      } catch {
        resolve(null);
      }
    });
    if (!isCurrent()) return;
    if (dataUrl) onPhoto(dataUrl);
  }
}

// Match the artifact endpoint's per-file and per-check admission limits.
export const CAPTURE_MAX_FILES = 20;
export const CAPTURE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CAPTURE_MAX_BYTES = 50 * 1024 * 1024;

/** @param {{media?: {size: number}, dataUrl?: string, upload?: {contentLength?: number}}} item */
function photoBytes(item) {
  if (item.media) return item.media.size;
  if (!item.dataUrl) return item.upload?.contentLength || 0;
  const body = item.dataUrl.slice(item.dataUrl.indexOf(",") + 1);
  return (
    Math.floor((body.length * 3) / 4) -
    (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0)
  );
}

/** Reserves selected files synchronously, including batches waiting to read. */
export class CaptureFileQueue {
  /** @param {boolean} [binary] */
  constructor(binary = false) {
    this.binary = binary;
    /** @type {Set<{file: File}>} */
    this.pending = new Set();
    this.tail = Promise.resolve();
  }

  get busy() {
    return this.pending.size > 0;
  }

  /**
   * @param {File[]} files
   * @param {Array<{kind?: string, media?: {size: number}, dataUrl?: string, upload?: {contentLength?: number}}>} items
   * @param {() => boolean} isCurrent
   * @param {(photo: any) => void | Promise<unknown>} onPhoto
   * @param {() => void} onChange
   */
  enqueue(files, items, isCurrent, onPhoto, onChange) {
    const admitted = items.filter(
      (item) => !("captureSaving" in item && item.captureSaving),
    );
    let count = admitted.length + this.pending.size;
    let bytes =
      admitted.reduce((sum, item) => sum + photoBytes(item), 0) +
      [...this.pending].reduce((sum, entry) => sum + entry.file.size, 0);
    const accepted = [];
    for (const file of files) {
      if (
        file.size > CAPTURE_MAX_FILE_BYTES ||
        count >= CAPTURE_MAX_FILES ||
        bytes + file.size > CAPTURE_MAX_BYTES
      )
        continue;
      const entry = { file };
      accepted.push(entry);
      this.pending.add(entry);
      count++;
      bytes += file.size;
    }
    if (!accepted.length) return files.length;
    onChange();
    this.tail = this.tail.then(async () => {
      try {
        for (const entry of accepted) {
          if (!isCurrent()) break;
          try {
            if (this.binary) {
              await onPhoto(entry.file);
            } else
              await readCaptureFiles([entry.file], isCurrent, (dataUrl) => {
                this.pending.delete(entry);
                onPhoto(dataUrl);
              });
          } finally {
            this.pending.delete(entry);
          }
        }
      } finally {
        for (const entry of accepted) this.pending.delete(entry);
        if (isCurrent()) onChange();
      }
    });
    return files.length - accepted.length;
  }
}
