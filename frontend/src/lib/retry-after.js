/**
 * Normalize Retry-After without starting a timer or replaying a request.
 * @param {string | null | undefined} value
 * @param {number} [now]
 * @returns {number | undefined} Non-negative delay in milliseconds.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const delay = Number(text) * 1000;
    return Number.isSafeInteger(delay) ? delay : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
