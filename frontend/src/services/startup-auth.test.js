import { describe, expect, it } from "vitest";

import {
  hasEnrollmentCredentials,
  isFatalSessionError,
} from "./startup-auth.js";

describe("startup authentication", () => {
  it("recognizes a complete enrollment fragment", () => {
    expect(
      hasEnrollmentCredentials(
        "http://localhost:5173/#enrollment_grant=grant-1&enrollment_token=secret",
      ),
    ).toBe(true);
  });

  it.each([
    "http://localhost:5173/",
    "http://localhost:5173/#enrollment_grant=grant-1",
    "http://localhost:5173/#enrollment_token=secret",
    "not a url",
  ])("rejects an incomplete enrollment URL: %s", (href) => {
    expect(hasEnrollmentCredentials(href)).toBe(false);
  });

  it("treats rejected and revoked sessions as fatal", () => {
    expect(
      isFatalSessionError(
        Object.assign(new Error("reauth"), { name: "ReauthRequiredError" }),
      ),
    ).toBe(true);
    expect(
      isFatalSessionError(
        Object.assign(new Error("forbidden"), { status: 403 }),
      ),
    ).toBe(true);
  });

  it("keeps transient failures in best-effort mode", () => {
    expect(
      isFatalSessionError(Object.assign(new Error("offline"), { status: 0 })),
    ).toBe(false);
    expect(
      isFatalSessionError(Object.assign(new Error("server"), { status: 503 })),
    ).toBe(false);
  });
});
