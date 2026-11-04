/**
 * @param {number} statusCode
 * @param {unknown} body
 * @returns {import("aws-lambda").APIGatewayProxyResult}
 */
export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Parse a proxy event's JSON body, transparently decoding base64. Returns
 * `undefined` for an empty body and throws `SyntaxError` on malformed JSON
 * (callers map that to a 400).
 * @param {{ body?: string | null, isBase64Encoded?: boolean }} event
 * @returns {unknown}
 */
export function readJsonBody(event) {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

/**
 * A positive integer page size from a query-string value, or `undefined` when
 * absent or unusable (callers then apply their own default or no limit).
 * @param {string | undefined} raw
 * @returns {number | undefined}
 */
export function parseLimit(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
