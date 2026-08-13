import { describe, expect, it } from "vitest";
import { buildProxyEvent } from "./lib/proxy-event.mjs";

// Pure unit test for the local router's event builder — no JVM, no server, no
// AWS. Guards the three behaviors the handlers actually depend on.

describe("buildProxyEvent", () => {
  it("lowercases header keys so handlers find them like API Gateway", () => {
    const event = buildProxyEvent({
      method: "POST",
      path: "/submissions",
      headers: { "Idempotency-Key": "abc", "Content-Type": "application/json" },
      body: "{}",
      defaultSub: "fallback",
    });
    expect(event.headers["idempotency-key"]).toBe("abc");
    expect(event.headers["content-type"]).toBe("application/json");
  });

  it("uses X-Debug-Sub as the authorizer sub when present", () => {
    const event = buildProxyEvent({
      method: "POST",
      path: "/submissions",
      headers: { "x-debug-sub": "device-42" },
      body: "{}",
      defaultSub: "fallback",
    });
    expect(event.requestContext.authorizer.jwt.claims.sub).toBe("device-42");
  });

  it("falls back to defaultSub when no X-Debug-Sub header is sent", () => {
    const event = buildProxyEvent({
      method: "GET",
      path: "/health",
      headers: {},
      body: "",
      defaultSub: "local-dev-user",
    });
    expect(event.requestContext.authorizer.jwt.claims.sub).toBe(
      "local-dev-user",
    );
  });

  it("carries method/path and a v2 shape the handlers can read", () => {
    const event = buildProxyEvent({
      method: "POST",
      path: "/submissions",
      headers: {},
      body: '{"hello":"world"}',
      defaultSub: "s",
    });
    expect(event.version).toBe("2.0");
    expect(event.requestContext.http.method).toBe("POST");
    expect(event.requestContext.http.path).toBe("/submissions");
    expect(event.rawPath).toBe("/submissions");
    expect(event.isBase64Encoded).toBe(false);
    expect(event.body).toBe('{"hello":"world"}');
  });

  it("omits an empty body (no empty-string payload)", () => {
    const event = buildProxyEvent({
      method: "GET",
      path: "/health",
      headers: {},
      body: "",
      defaultSub: "s",
    });
    expect(event.body).toBeUndefined();
  });
});
