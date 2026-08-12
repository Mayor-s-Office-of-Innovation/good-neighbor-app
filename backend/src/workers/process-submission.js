import type { SQSHandler } from "aws-lambda";
import { prisma } from "../db.js";

type SubmissionMessage = {
  requestId: string;
  subject: string;
  body: string;
};

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SubmissionMessage;

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
