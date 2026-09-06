import { describe, expect, it } from "vitest";
import { deriveSiteId } from "./principal.js";

/**
 * JWT-authorizer shape (Cognito / the local X-Debug stub): claims nested under
 * `authorizer.jwt.claims`.
 * @param {Record<string, unknown>} [claims]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
const eventWithJwtClaims = (claims) =>
  /** @type {any} */ ({
    requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
  });

/**
 * REQUEST-authorizer shape (device tokens, ADR 0010): the authorizer's flat
 * context map, keys verbatim — API Gateway flattens `context` to
 * `$context.authorizer.<key>` and nested objects aren't supported.
 * @param {Record<string, string>} [context]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
const eventWithRequestContext = (context) =>
  /** @type {any} */ ({
    requestContext: context ? { authorizer: context } : {},
  });

describe("deriveSiteId", () => {
  it("uses the custom:siteId JWT claim when present", () => {
    expect(
      deriveSiteId(eventWithJwtClaims({ "custom:siteId": "site-42" })),
    ).toBe("site-42");
  });

  it("uses the flat REQUEST-authorizer context when present", () => {
    expect(
      deriveSiteId(
        eventWithRequestContext({
          "claims.sub": "dev-1",
          "claims.custom:siteId": "site-7",
          "claims.ver": "3",
        }),
      ),
    ).toBe("site-7");
  });

  it("prefers the flat context over the nested JWT shape", () => {
    expect(
      deriveSiteId(
        /** @type {any} */ ({
          requestContext: {
            authorizer: {
              "claims.custom:siteId": "site-flat",
              jwt: { claims: { "custom:siteId": "site-nested" } },
            },
          },
        }),
      ),
    ).toBe("site-flat");
  });

  it("falls back to DEMO_SITE_ID when the claim is absent", () => {
    expect(deriveSiteId(eventWithJwtClaims(), { DEMO_SITE_ID: "demo-7" })).toBe(
      "demo-7",
    );
    expect(
      deriveSiteId(eventWithRequestContext(), { DEMO_SITE_ID: "demo-7" }),
    ).toBe("demo-7");
  });

  it("falls back to demo-site when nothing is configured", () => {
    expect(deriveSiteId(eventWithJwtClaims(), {})).toBe("demo-site");
    expect(deriveSiteId(eventWithRequestContext(), {})).toBe("demo-site");
  });

  it("ignores a non-string claim", () => {
    expect(
      deriveSiteId(eventWithJwtClaims({ "custom:siteId": 123 }), {
        DEMO_SITE_ID: "demo-7",
      }),
    ).toBe("demo-7");
  });
});
