import {
  getCaptureMedia,
  saveCapturePhoto,
  cacheCaptureThumbnail,
} from "../db.js";
import { contentTypeFromDataUrl, dataUrlToBlob } from "./api.js";
import { cachedMediaUrls, invalidateMediaUrls } from "./task-evidence.js";

/** Move old inline photos one at a time; failure leaves the original recoverable.
 * @param {any} check
 */
export async function migrateCaptureMedia(check) {
  for (const item of check.items || []) {
    if (item.kind !== "photo" || !item.dataUrl || item.media) continue;
    const migrate = async () => {
      const dataUrl = item.dataUrl;
      try {
        const registered =
          item.upload?.status === "uploaded" && item.upload.artifactId;
        // Registered legacy photos need only metadata; do not decode megabytes just to discard them.
        const type =
          item.upload?.contentType || contentTypeFromDataUrl(dataUrl);
        const blob = registered
          ? new Blob([], { type })
          : await dataUrlToBlob(dataUrl);
        const size = registered
          ? item.upload?.contentLength ||
            Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4) -
              (dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0)
          : blob.size;
        item.media = {
          key: JSON.stringify([check.siteId, check.id, item.id]),
          size,
          type,
        };
        if (!(await saveCapturePhoto(check, item, blob))) {
          check.items = check.items.filter((candidate) => candidate !== item);
          return;
        }
        delete item.dataUrl;
      } catch {
        delete item.media;
        // Quota/upgrade failures must not discard a legacy draft.
      }
    };
    const locks = globalThis.navigator?.locks;
    if (locks)
      await locks.request(
        `check-item:${item.id}`,
        { ifAvailable: true },
        (lock) => (lock ? migrate() : undefined),
      );
    else await migrate();
  }
}

const pending = new Map();
const retryAfter = new Map();
/** Coalesce grid/card requests. Store no original or signed URL in this cache.
 * @param {string} key @param {string} checkId @param {string} artifactId
 * @returns {Promise<Blob|null>}
 */
export function captureThumbnail(key, checkId, artifactId) {
  if (!artifactId) return Promise.resolve(null);
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    let media = await getCaptureMedia(key);
    if (!media) return null;
    if (media.thumbnail) return media.thumbnail;
    media = null; // Do not hold a pending original across thumbnail network waits.
    if (!artifactId || navigator.onLine === false) return null;
    if ((retryAfter.get(key) || 0) > Date.now()) return null;
    // Grid and results may both show this item; share backoff as well as in-flight work.
    retryAfter.set(key, Date.now() + 4000);
    if (retryAfter.size > 100)
      retryAfter.delete(retryAfter.keys().next().value);
    invalidateMediaUrls(checkId, artifactId);
    const urls = await cachedMediaUrls(checkId, artifactId);
    if (!urls.thumbnailUrl) return null;
    const response = await fetch(urls.thumbnailUrl, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const thumbnail = await response.blob();
    if (!thumbnail.type.startsWith("image/") || thumbnail.size > 1024 * 1024)
      return null;
    retryAfter.delete(key);
    return (await cacheCaptureThumbnail(key, artifactId, thumbnail))
      ? thumbnail
      : null;
  })().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
