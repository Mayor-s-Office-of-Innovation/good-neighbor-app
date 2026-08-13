import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";

const sqs = new SQSClient({});

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const handler = async (event) => {
  const config = getConfig();
  const subject = event.requestContext.authorizer.jwt.claims.sub;
  const requestId = event.headers["idempotency-key"];

  if (!subject || typeof subject !== "string") {
    return jsonResponse(401, { error: "unauthorized" });
  }

  if (!requestId) {
    return jsonResponse(400, { error: "Missing idempotency-key header" });
  }

  if (!event.body) {
    return jsonResponse(400, { error: "Missing request body" });
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queueUrl,
      MessageBody: JSON.stringify({
        requestId,
        subject,
        body: event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body,
      }),
    }),
  );

  return jsonResponse(202, { id: requestId, status: "queued" });
};
