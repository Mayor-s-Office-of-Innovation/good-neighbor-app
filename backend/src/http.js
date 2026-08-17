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
