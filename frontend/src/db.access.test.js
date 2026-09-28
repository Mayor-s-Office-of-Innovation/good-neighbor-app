import { describe, expect, it } from "vitest";
import { hasAdminAccess } from "./db.js";

/** @param {Record<string, unknown>} claims */
function token(claims) {
  const payload = btoa(JSON.stringify(claims))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

describe("hasAdminAccess", () => {
  it("accepts the stored binding role", () => {
    expect(hasAdminAccess({ accessLevel: "admin" })).toBe(true);
  });

  it("falls back to an admin claim when an older binding lacks the field", () => {
    expect(hasAdminAccess({ token: token({ accessLevel: "admin" }) })).toBe(
      true,
    );
  });

  it("does not elevate missing or general access claims", () => {
    expect(hasAdminAccess({ token: token({}) })).toBe(false);
    expect(hasAdminAccess({ token: token({ accessLevel: "general" }) })).toBe(
      false,
    );
  });
});
