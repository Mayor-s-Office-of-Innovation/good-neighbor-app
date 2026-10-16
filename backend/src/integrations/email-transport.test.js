import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredEmailProvider,
  resetEmailTransportForTest,
  sendEmail,
} from "./email-transport.js";

const { sesSend, secretSend, sendMail, close, createTransport } = vi.hoisted(
  () => ({
    sesSend: vi.fn(),
    secretSend: vi.fn(),
    sendMail: vi.fn(),
    close: vi.fn(),
    createTransport: vi.fn(),
  }),
);

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => ({
  ...(await importOriginal()),
  SESv2Client: class {
    send = sesSend;
  },
}));

vi.mock("@aws-sdk/client-secrets-manager", async (importOriginal) => ({
  ...(await importOriginal()),
  SecretsManagerClient: class {
    send = secretSend;
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

const email = {
  from: "goodneighbor-dev@sf.gov",
  to: "recipient@example.org",
  replyTo: "support@example.org",
  subject: "[dev] Test",
  text: "Plain text",
  html: "<p>HTML</p>",
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("EMAIL_TRANSPORT", "ses");
  vi.stubEnv("MAIL_MANAGER_SMTP_HOST", "");
  vi.stubEnv("MAIL_MANAGER_SMTP_USERNAME", "");
  vi.stubEnv("MAIL_MANAGER_SMTP_SECRET_ARN", "");
  resetEmailTransportForTest();
  sesSend.mockReset().mockResolvedValue({ MessageId: "ses-123" });
  secretSend.mockReset();
  sendMail.mockReset().mockResolvedValue({ messageId: "smtp-123" });
  close.mockReset();
  createTransport.mockReset().mockReturnValue({ sendMail, close });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("sendEmail", () => {
  it("uses direct SES when SMTP is not enabled", async () => {
    await expect(sendEmail(email)).resolves.toEqual({
      provider: "ses",
      messageId: "ses-123",
    });
    expect(sesSend).toHaveBeenCalledOnce();
    expect(secretSend).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it.each(["ses", "smtp"])(
    "includes CC recipients and PDF attachments through %s",
    async (provider) => {
      vi.stubEnv("EMAIL_TRANSPORT", provider);
      vi.stubEnv("MAIL_MANAGER_SMTP_HOST", "mail-manager.example");
      vi.stubEnv("MAIL_MANAGER_SMTP_USERNAME", "inp-example");
      vi.stubEnv(
        "MAIL_MANAGER_SMTP_SECRET_ARN",
        "arn:aws:secretsmanager:secret",
      );
      secretSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: "test" }),
      });
      const content = Buffer.from("PDF");
      await sendEmail({
        ...email,
        cc: ["copy@example.org"],
        attachments: [
          { filename: "letter.pdf", content, contentType: "application/pdf" },
        ],
      });
      if (provider === "smtp") {
        expect(sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            cc: ["copy@example.org"],
            envelope: { from: email.from, to: [email.to, "copy@example.org"] },
            attachments: [
              {
                filename: "letter.pdf",
                content,
                contentType: "application/pdf",
              },
            ],
          }),
        );
      } else {
        expect(sesSend.mock.calls[0][0].input).toMatchObject({
          Destination: { CcAddresses: ["copy@example.org"] },
          Content: {
            Simple: {
              Attachments: [{ FileName: "letter.pdf", RawContent: content }],
            },
          },
        });
      }
    },
  );

  it("uses authenticated STARTTLS and caches the ingress credential", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "smtp");
    vi.stubEnv("MAIL_MANAGER_SMTP_HOST", "mail-manager.example");
    vi.stubEnv("MAIL_MANAGER_SMTP_USERNAME", "inp-example");
    vi.stubEnv("MAIL_MANAGER_SMTP_SECRET_ARN", "arn:aws:secretsmanager:secret");
    secretSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: "not-logged" }),
    });

    await expect(sendEmail(email)).resolves.toEqual({
      provider: "smtp",
      messageId: "smtp-123",
    });
    await sendEmail({ ...email, to: "second@example.org" });

    expect(configuredEmailProvider()).toBe("smtp");
    expect(secretSend).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledWith({
      host: "mail-manager.example",
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
      auth: { user: "inp-example", pass: "not-logged" },
      tls: { minVersion: "TLSv1.2", servername: "mail-manager.example" },
    });
    expect(sendMail).toHaveBeenNthCalledWith(1, {
      from: email.from,
      envelope: { from: email.from, to: [email.to] },
      to: email.to,
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    expect(sesSend).not.toHaveBeenCalled();
  });

  it("rejects an invalid ingress secret without attempting delivery", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "smtp");
    vi.stubEnv("MAIL_MANAGER_SMTP_HOST", "mail-manager.example");
    vi.stubEnv("MAIL_MANAGER_SMTP_USERNAME", "inp-example");
    vi.stubEnv("MAIL_MANAGER_SMTP_SECRET_ARN", "arn:aws:secretsmanager:secret");
    secretSend.mockResolvedValue({ SecretString: "{}" });

    await expect(sendEmail(email)).rejects.toThrow("Invalid SMTP secret value");
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("refreshes the ingress credential after the transport cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    configureSmtp();
    secretSend
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({ password: "first-password" }),
      })
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({ password: "rotated-password" }),
      });

    await sendEmail(email);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await sendEmail(email);

    expect(secretSend).toHaveBeenCalledTimes(2);
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auth: { user: "inp-example", pass: "rotated-password" },
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("reloads the credential and retries once after an auth rejection", async () => {
    configureSmtp();
    secretSend
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({ password: "first-password" }),
      })
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({ password: "rotated-password" }),
      });
    sendMail
      .mockRejectedValueOnce(
        Object.assign(new Error("rejected"), { code: "EAUTH" }),
      )
      .mockResolvedValueOnce({ messageId: "smtp-after-rotation" });

    await expect(sendEmail(email)).resolves.toEqual({
      provider: "smtp",
      messageId: "smtp-after-rotation",
    });

    expect(secretSend).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auth: { user: "inp-example", pass: "rotated-password" },
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops after one retry when authentication is rejected again", async () => {
    configureSmtp();
    secretSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: "rejected-password" }),
    });
    const authenticationError = Object.assign(new Error("rejected"), {
      code: "EAUTH",
    });
    sendMail.mockRejectedValue(authenticationError);

    await expect(sendEmail(email)).rejects.toBe(authenticationError);

    expect(secretSend).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not retry an SMTP failure with ambiguous delivery status", async () => {
    configureSmtp();
    secretSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: "current-password" }),
    });
    const timeout = Object.assign(new Error("socket timed out"), {
      code: "ETIMEDOUT",
    });
    sendMail.mockRejectedValueOnce(timeout);

    await expect(sendEmail(email)).rejects.toBe(timeout);

    expect(secretSend).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

/** Configure the environment for the SMTP transport tests. */
function configureSmtp() {
  vi.stubEnv("EMAIL_TRANSPORT", "smtp");
  vi.stubEnv("MAIL_MANAGER_SMTP_HOST", "mail-manager.example");
  vi.stubEnv("MAIL_MANAGER_SMTP_USERNAME", "inp-example");
  vi.stubEnv("MAIL_MANAGER_SMTP_SECRET_ARN", "arn:aws:secretsmanager:secret");
}
