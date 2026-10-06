/**
 * Enrollment links must take precedence over a locally cached device binding.
 * Otherwise a revoked binding can mask a fresh one-time grant and leave that
 * grant pending forever.
 * @param {string} [href]
 * @returns {boolean}
 */
export function hasEnrollmentCredentials(href = globalThis.location?.href) {
  if (!href) return false;
  try {
    const fragment = new URLSearchParams(new URL(href).hash.slice(1));
    return Boolean(
      fragment.get("enrollment_grant")?.trim() &&
        fragment.get("enrollment_token")?.trim(),
    );
  } catch {
    return false;
  }
}

/**
 * Identify a response that proves the cached device session cannot be used.
 * Network and server failures remain best-effort so they do not log out an
 * otherwise valid device during an outage.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isFatalSessionError(error) {
  if (!(error instanceof Error)) return false;
  if (error.name === "ReauthRequiredError") return true;
  const status = /** @type {{ status?: unknown }} */ (error).status;
  return status === 401 || status === 403;
}
