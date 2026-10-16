import { beforeEach, it, expect, vi } from "vitest";
import { UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const { send, mail, getObjectBytes } = vi.hoisted(() => ({
  send: vi.fn(),
  mail: vi.fn(),
  getObjectBytes: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ getObjectBytes }));
vi.mock("../integrations/email-transport.js", () => ({ sendEmail: mail }));
import { deliverComplianceLetter } from "./deliver-compliance-letter.js";
const job = {
  pk: "SITE#one",
  sk: "LETTER_JOB#one",
  letterJobId: "one",
  status: "dispatched",
};
const email = {
  to: "site@example.org",
  cc: ["sender@example.org", "provider@example.org"],
  subject: "Requirements",
  text: "Dear Sam",
};
const letter = { s3Key: "letter.pdf", fileName: "letter.pdf" };
beforeEach(() => {
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  vi.stubEnv("S3_COMPLIANCE_LETTER_BUCKET", "letters");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "worker");
  vi.stubEnv("SETUP_CODE_EMAIL_FROM", "app@sf.gov");
  send.mockReset().mockResolvedValue({ Item: { letterEmailCount: 2 } });
  mail
    .mockReset()
    .mockResolvedValue({ provider: "smtp", messageId: "receipt" });
  getObjectBytes.mockReset().mockResolvedValue({ bytes: Buffer.from("PDF") });
});
it("sends the saved PDF and CC list, then atomically numbers history", async () => {
  await deliverComplianceLetter(job, email, letter);
  expect(mail).toHaveBeenCalledWith(
    expect.objectContaining({
      ...email,
      attachments: [
        {
          filename: "letter.pdf",
          content: Buffer.from("PDF"),
          contentType: "application/pdf",
        },
      ],
    }),
  );
  const transaction = /** @type {any} */ (
    send.mock.calls
      .map(([c]) => c)
      .find((c) => c instanceof TransactWriteCommand)
  );
  expect(transaction.input.TransactItems[1].Put.Item).toMatchObject({
    number: 3,
    recipients: [email.to, ...email.cc],
    messageId: "receipt",
    letter,
  });
});
it("does not send again when delivery was already accepted", async () => {
  await deliverComplianceLetter(
    {
      ...job,
      receipt: { messageId: "accepted", sentAt: "2026-10-16T00:00:00Z" },
    },
    email,
    letter,
  );
  expect(mail).not.toHaveBeenCalled();
  expect(getObjectBytes).not.toHaveBeenCalled();
});
it("does not repeat ambiguous or concurrent sends", async () => {
  send
    .mockRejectedValueOnce(
      Object.assign(new Error(), { name: "ConditionalCheckFailedException" }),
    )
    .mockResolvedValueOnce({ Item: { deliveryState: "sending" } });
  await expect(deliverComplianceLetter(job, email, letter)).rejects.toThrow(
    "reconciliation",
  );
  expect(mail).not.toHaveBeenCalled();
});
it("does not record a sent email when transport fails", async () => {
  mail.mockRejectedValueOnce(new Error("timeout"));
  await expect(deliverComplianceLetter(job, email, letter)).rejects.toThrow(
    "timeout",
  );
  expect(send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(
    false,
  );
  expect(send.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
});
