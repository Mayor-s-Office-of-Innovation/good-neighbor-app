import { getUploadRequestId } from "../db.js";

/**
 * Save the file's retry identity before presigning; rotate it only when the
 * server explicitly reports expiration. A lost response keeps the same ID.
 * @template T
 * @param {string} scope
 * @param {Blob} blob
 * @param {(requestId: string) => Promise<T>} presign
 * @returns {Promise<T>} Upload coordinates.
 */
export async function reserveMediaUpload(scope, blob, presign) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  const fingerprint = `${blob.type}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let requestId = await getUploadRequestId(scope, fingerprint);
  try {
    return await presign(requestId);
  } catch (error) {
    if (error?.status !== 410 || error?.body?.error !== "upload_expired")
      throw error;
    requestId = await getUploadRequestId(scope, fingerprint, requestId);
    return presign(requestId);
  }
}
