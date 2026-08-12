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
