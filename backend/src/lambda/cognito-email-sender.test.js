import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, messageForEvent } from "./cognito-email-sender.js";

const { decrypt, sendEmail } = vi.hoisted(() => ({
  decrypt: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@aws-crypto/client-node", () => ({
  CommitmentPolicy: { REQUIRE_ENCRYPT_ALLOW_DECRYPT: "strict" },
  KmsKeyringNode: class {},
  buildClient: () => ({ decrypt }),
}));

vi.mock("../integrations/email-transport.js", () => ({ sendEmail }));

const info = vi.spyOn(console, "info");

const baseEvent = {
  userPoolId: "us-west-2_example",
  userName: "manager@example.org",
  triggerSource: "CustomEmailSender_AdminCreateUser",
  request: {
    type: "customEmailSenderRequestV1",
    code: "ciphertext",
    userAttributes: { email: "manager@example.org" },
  },
};

beforeEach(() => {
  vi.stubEnv("ENVIRONMENT", "dev");
  vi.stubEnv("ADMIN_APP_URL", "https://dev-admin.example.org/");
  vi.stubEnv("COGNITO_EMAIL_KMS_KEY_ARN", "arn:aws:kms:key/example");
  vi.stubEnv("SETUP_CODE_EMAIL_FROM", "goodneighbor-dev@sf.gov");
  vi.stubEnv("SETUP_CODE_EMAIL_SUBJECT_PREFIX", "[dev] ");
  decrypt.mockReset().mockResolvedValue({
    plaintext: Buffer.from("Temp&lt;&amp;&gt;Password"),
    messageHeader: {
      encryptionContext: { "userpool-id": "us-west-2_example" },
    },
  });
  sendEmail.mockReset().mockResolvedValue({
    provider: "smtp",
    messageId: "message-1",
  });
  info.mockReset().mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Cognito custom email sender", () => {
  it("sends the environment-specific compliance app invitation", async () => {
    await handler(baseEvent);

    expect(sendEmail).toHaveBeenCalledWith({
      from: "goodneighbor-dev@sf.gov",
      to: "manager@example.org",
      replyTo: "goodneighbor-dev@sf.gov",
      subject: "[dev] Your Good Neighbor compliance app invitation",
      text: expect.stringContaining("https://dev-admin.example.org/"),
      html: expect.stringContaining("Temp&lt;&amp;&gt;Password"),
    });
    const message = sendEmail.mock.calls[0][0];
    expect(message.text).toContain("Temp<&>Password");
    expect(message.text).toContain("goodneighbor-dev@sf.gov");
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      "manager@example.org",
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("Temp<&>Password");
  });

  it("preserves minimal verification-code wording for reset messages", () => {
    const message = messageForEvent(
      { ...baseEvent, triggerSource: "CustomEmailSender_ForgotPassword" },
      "123456",
    );
    expect(message).toEqual({
      subject: "Your verification code",
      text: "Your verification code is 123456.",
      html: "<p>Your verification code is <strong>123456</strong>.</p>",
    });
  });

  it("decodes Cognito password entities exactly once", async () => {
    decrypt.mockResolvedValue({
      plaintext: Buffer.from("Literal&amp;quot;Value"),
      messageHeader: {
        encryptionContext: { "userpool-id": "us-west-2_example" },
      },
    });

    await handler(baseEvent);

    const message = sendEmail.mock.calls[0][0];
    expect(message.text).toContain("Literal&quot;Value");
    expect(message.text).not.toContain('Literal"Value');
    expect(message.html).toContain("Literal&amp;quot;Value");
  });

  it("fails closed when the encryption context names another pool", async () => {
    decrypt.mockResolvedValue({
      plaintext: Buffer.from("secret"),
      messageHeader: { encryptionContext: { "userpool-id": "other-pool" } },
    });
    await expect(handler(baseEvent)).rejects.toThrow(
      "Unexpected Cognito encryption context",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects unknown trigger sources", () => {
    expect(() =>
      messageForEvent({ ...baseEvent, triggerSource: "Unknown" }, "123456"),
    ).toThrow("Unsupported trigger");
  });
});
