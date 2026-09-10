import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSetupCodeEmail } from "./email.js";

const EMAIL = {
  to: "lead@example.org",
  siteName: "City Hall",
  code: "ABC123",
  expiresAt: "2026-09-13T00:00:00.000Z",
  appUrl: "https://goodneighborsf.org/",
};

describe("sendSetupCodeEmail", () => {
  /** @type {ReturnType<typeof vi.spyOn>} */
  let info;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    info.mockRestore();
    vi.unstubAllEnvs();
  });

  it("omits redeemable setup-code values from default logs", async () => {
    await sendSetupCodeEmail(EMAIL);

    const payload = loggedPayload();
    expect(payload).toMatchObject({
      marker: "setup_code_email",
      provider: "log",
      to: "lead@example.org",
      siteName: "City Hall",
      expiresAt: "2026-09-13T00:00:00.000Z",
    });
    expect(JSON.stringify(payload)).not.toContain("ABC123");
    expect(JSON.stringify(payload)).not.toContain("code=");
  });

  it("includes the setup-code URL only for explicit local logging", async () => {
    vi.stubEnv("SETUP_CODE_EMAIL_LOG_CODES", "true");

    await sendSetupCodeEmail(EMAIL);

    expect(loggedPayload().localOpenUrl).toBe(
      "https://goodneighborsf.org/?code=ABC123",
    );
  });

  /**
   * @returns {Record<string, unknown>}
   */
  function loggedPayload() {
    return JSON.parse(String(info.mock.calls[0][0]));
  }
});
