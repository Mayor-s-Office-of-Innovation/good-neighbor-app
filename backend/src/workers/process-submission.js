import { prisma } from "../db.js";

/**
 * @typedef {object} SubmissionMessage
 * @property {string} requestId
 * @property {string} subject
 * @property {string} body
 */

/** @type {import("aws-lambda").SQSHandler} */
export const handler = async (event) => {
  for (const record of event.Records) {
    const message = /** @type {SubmissionMessage} */ (JSON.parse(record.body));

    await prisma.offlineSubmission.upsert({
      where: { id: message.requestId },
      create: {
        id: message.requestId,
        cognitoSubject: message.subject,
        payload: JSON.parse(message.body),
        status: "received",
      },
      update: {
        status: "duplicate_replay",
      },
    });
  }
};
