import { URLSearchParams } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSetupCodeEmail } from "./email.js";

const EMAIL = {
  to: "lead@example.org",
  siteName: "City Hall",
  code: "ABC123",
  expiresAt: "2026-09-13T00:00:00.000Z",
  appUrl: "https://goodneighborsf.org/",
};

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => ({
  ...(await importOriginal()),
  SESv2Client: class {
    send = send;
  },
}));
const info = vi.spyOn(console, "info");
const error = vi.spyOn(console, "error");

beforeEach(() => {
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "good-neighbor-app-dev-api");
  vi.stubEnv("LOCAL_API_PORT", "");
  vi.stubEnv("SETUP_CODE_EMAIL_LOG_CODES", "");
  vi.stubEnv("SETUP_CODE_EMAIL_FROM", "codes@goodneighborsf.org");
  vi.stubEnv("SETUP_CODE_EMAIL_SUBJECT_PREFIX", "[dev] ");
  vi.stubEnv("SETUP_CODE_EMAIL_REPLY_TO", "support@example.org");
  send.mockReset().mockResolvedValue({ MessageId: "ses-123" });
  info.mockReset().mockImplementation(() => {});
  error.mockReset().mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

describe("sendSetupCodeEmail", () => {
  it("sends text and escaped HTML with code, expiry, link and environment label", async () => {
    expect(
      await sendSetupCodeEmail({ ...EMAIL, siteName: '<b>Hall & "Annex"</b>' }),
    ).toEqual({ provider: "ses", messageId: "ses-123" });
    const input =
      /** @type {import('@aws-sdk/client-sesv2').SendEmailCommand} */ (
        send.mock.calls[0][0]
      ).input;
    expect(input.FromEmailAddress).toBe("codes@goodneighborsf.org");
    expect(input.Destination).toEqual({ ToAddresses: [EMAIL.to] });
    expect(input.ReplyToAddresses).toEqual(["support@example.org"]);
    expect(input.Content?.Simple?.Subject?.Data).toBe(
      "[dev] Your Good Neighbor setup code",
    );
    const body = input.Content?.Simple?.Body;
    for (const content of [body?.Text?.Data, body?.Html?.Data]) {
      expect(content).toContain("ABC123");
      expect(content).toContain("https://goodneighborsf.org/#code=ABC123");
      expect(content).toContain("September 12, 2026");
      expect(content).toContain("PDT");
      expect(content).toContain("trusted work device");
    }
    expect(body?.Html?.Data).toContain(
      "&lt;b&gt;Hall &amp; &quot;Annex&quot;&lt;/b&gt;",
    );
    expect(body?.Html?.Data).not.toContain("<b>Hall");
    expect(JSON.stringify(info.mock.calls)).not.toContain(EMAIL.code);
    expect(JSON.stringify(info.mock.calls)).not.toContain(EMAIL.to);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      status: "accepted",
      messageId: "ses-123",
    });
  });

  it("keeps redeemable codes out of the query even when the app URL has a legacy code", async () => {
    await sendSetupCodeEmail({
      ...EMAIL,
      appUrl:
        "https://goodneighborsf.org/?code=OLD123&theme=dark#section=setup",
    });
    const text = send.mock.calls[0][0].input.Content.Simple.Body.Text.Data;
    const url = new URL(text.match(/https:\/\/[^\s]+/)[0]);
    expect(url.searchParams.has("code")).toBe(false);
    expect(url.search).not.toContain(EMAIL.code);
    expect(url.searchParams.get("theme")).toBe("dark");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("code")).toBe(EMAIL.code);
    expect(fragment.get("section")).toBe("setup");
  });

  it("keeps local preview offline even with a sender configured", async () => {
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
    vi.stubEnv("LOCAL_API_PORT", "3000");
    expect(
      (await sendSetupCodeEmail({ ...EMAIL, appUrl: "http://localhost:5173/" }))
        .provider,
    ).toBe("log");
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0][0])).localOpenUrl).toBe(
      "http://localhost:5173/#code=ABC123",
    );
  });

  it("ignores local code-logging flags in Lambda", async () => {
    vi.stubEnv("LOCAL_API_PORT", "3000");
    vi.stubEnv("SETUP_CODE_EMAIL_LOG_CODES", "true");
    await sendSetupCodeEmail(EMAIL);
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(info.mock.calls)).not.toContain(EMAIL.code);
  });

  it("rejects missing sender configuration without falling back to logging", async () => {
    vi.stubEnv("SETUP_CODE_EMAIL_FROM", "");
    await expect(sendSetupCodeEmail(EMAIL)).rejects.toThrow(
      "Setup-code email delivery failed",
    );
    expect(send).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS deployment links", async () => {
    await expect(
      sendSetupCodeEmail({ ...EMAIL, appUrl: "http://localhost:5173/" }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("sanitizes SES errors and never logs or rethrows request content", async () => {
    send.mockRejectedValueOnce(new Error(`Rejected ${EMAIL.to} ${EMAIL.code}`));
    await expect(sendSetupCodeEmail(EMAIL)).rejects.toThrow(
      "Setup-code email delivery failed",
    );
    expect(info).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(EMAIL.code);
    expect(JSON.stringify(error.mock.calls)).not.toContain(EMAIL.to);
    expect(JSON.parse(String(error.mock.calls[0][0])).status).toBe("failed");
  });
});
