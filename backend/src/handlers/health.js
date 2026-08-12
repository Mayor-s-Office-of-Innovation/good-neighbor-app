import { jsonResponse } from "../http.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const handler = async () => {
  return jsonResponse(200, {
    ok: true,
    service: "good-neighbor-app",
  });
};
