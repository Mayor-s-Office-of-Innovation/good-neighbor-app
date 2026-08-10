import type { APIGatewayProxyResult } from "aws-lambda";

export function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
