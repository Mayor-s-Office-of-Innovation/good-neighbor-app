import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredEmailProvider,
  resetEmailTransportForTest,
  sendEmail,
} from "./email-transport.js";

const { sesSend, secretSend, sendMail, createTransport } = vi.hoisted(() => ({
  sesSend: vi.fn(),
  secretSend: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

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
  createTransport.mockReset().mockReturnValue({ sendMail });
});

afterEach(() => vi.unstubAllEnvs());

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
});
