// iOS copies cookies when creating a Home Screen app, but not IndexedDB.
// This short-lived, single-use grant bootstraps an independent device session.
export const HANDOFF_COOKIE = "__Secure-gnp-handoff";
const COOKIE_PATH = "/app/v1/session-handoff";

/** @param {string} [value] @param {number} [maxAge] */
export function handoffCookie(value = "", maxAge = 0) {
  return `${HANDOFF_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

/** @param {{ cookies?: string[], headers?: Record<string, string | undefined> }} event */
export function readHandoffCookie(event) {
  const cookies =
    event.cookies ??
    (event.headers?.cookie ?? event.headers?.Cookie ?? "").split(";");
  const value =
    cookies
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${HANDOFF_COOKIE}=`))
      ?.slice(HANDOFF_COOKIE.length + 1) ?? "";
  const [grantId = "", token = "", extra] = value.split(".");
  if (
    extra !== undefined ||
    !/^[\w-]+$/.test(grantId) ||
    !/^[\w-]+$/.test(token)
  ) {
    return { grantId: "", token: "" };
  }
  return { grantId, token };
}
