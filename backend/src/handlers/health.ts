import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { jsonResponse } from "../http.js";

export const handler: APIGatewayProxyHandlerV2 = async () => {
  return jsonResponse(200, {
    ok: true,
    service: "good-neighbor-app",
  });
};
