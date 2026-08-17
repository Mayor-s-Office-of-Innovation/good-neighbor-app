import { describe, expect, it } from "vitest";
import { deriveSiteId } from "./principal.js";

/**
 * @param {Record<string, unknown>} [claims]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
const eventWithClaims = (claims) =>
  /** @type {any} */ ({
    requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
  });

describe("deriveSiteId", () => {
  it("uses the custom:siteId JWT claim when present", () => {
    expect(deriveSiteId(eventWithClaims({ "custom:siteId": "site-42" }))).toBe(
      "site-42",
    );
  });

  it("falls back to DEMO_SITE_ID when the claim is absent", () => {
    expect(deriveSiteId(eventWithClaims(), { DEMO_SITE_ID: "demo-7" })).toBe(
      "demo-7",
    );
  });

  it("falls back to demo-site when nothing is configured", () => {
    expect(deriveSiteId(eventWithClaims(), {})).toBe("demo-site");
  });

  it("ignores a non-string claim", () => {
    expect(
      deriveSiteId(eventWithClaims({ "custom:siteId": 123 }), {
        DEMO_SITE_ID: "demo-7",
      }),
    ).toBe("demo-7");
  });
});
