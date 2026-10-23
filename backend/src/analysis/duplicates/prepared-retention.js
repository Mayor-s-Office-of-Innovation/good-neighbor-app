/** Cache lifecycle is three days from its own creation. Never create a persistent
 * derivative in the final three days of the original's 30-day retention window.
 * Missing authoritative S3 timestamps disable caching. Expired originals are not read.
 * @param {Date|undefined} lastModified @param {number} [now]
 */
export function preparedRetention(lastModified, now = Date.now()) {
  const uploaded = lastModified?.getTime();
  if (!Number.isFinite(uploaded))
    return { cacheable: false, expired: false, sourceExpiresAt: 0 };
  const sourceExpiresAt = /** @type {number} */ (uploaded) + 30 * 86400000;
  return {
    sourceExpiresAt,
    expired: now >= sourceExpiresAt,
    cacheable: now <= sourceExpiresAt - 3 * 86400000,
  };
}
