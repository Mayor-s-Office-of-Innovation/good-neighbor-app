/** Shared complaint and task-documentation attachment rules. */
export const MAX_IMAGE_FILE = 10 * 1024 * 1024;
export const MAX_DOCUMENT_FILE = Math.floor(4.5 * 1024 * 1024);
export const MAX_TOTAL = 25 * 1024 * 1024;
export const MAX_FILES = 5;

/** @param {{type: string, name: string}} file */
export function contentTypeFor(file) {
  return (
    file.type ||
    {
      heic: "image/heic",
      heif: "image/heif",
      pdf: "application/pdf",
      txt: "text/plain",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    }[file.name.split(".").pop()?.toLowerCase()] ||
    "application/octet-stream"
  );
}

/** Validate the entire draft, including photos selected in earlier batches.
 * @param {Array<Pick<File, "size" | "type" | "name">>} files
 */
export function validPhotoAttachments(files) {
  return (
    files.length <= MAX_FILES &&
    files.every(
      (file) =>
        file.size > 0 &&
        file.size <= MAX_IMAGE_FILE &&
        [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/heic",
          "image/heif",
        ].includes(contentTypeFor(file)),
    ) &&
    files.reduce((sum, file) => sum + file.size, 0) <= MAX_TOTAL
  );
}
