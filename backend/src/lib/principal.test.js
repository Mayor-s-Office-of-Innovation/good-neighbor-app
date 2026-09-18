import { describe, expect, it } from "vitest";
import { MissingSiteClaimError, deriveSiteId } from "./principal.js";

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
 * REQUEST-authorizer shape as delivered with integration payload format 2.0
 * (the deployed configuration): API Gateway nests the authorizer's `context`
 * map under `authorizer.lambda`, keys verbatim.
 * @param {Record<string, string>} [context]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
const eventWithLambdaContext = (context) =>
  /** @type {any} */ ({
    requestContext: context ? { authorizer: { lambda: context } } : {},
  });

/**
 * REQUEST-authorizer shape as delivered with integration payload format 1.0:
 * the context map flattened directly onto `authorizer`.
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

  it("reads the payload-2.0 REQUEST-authorizer context under authorizer.lambda", () => {
    expect(
      deriveSiteId(
        eventWithLambdaContext({
          "claims.sub": "dev-1",
          "claims.custom:siteId": "site-9",
          "claims.ver": "3",
        }),
      ),
    ).toBe("site-9");
  });

  it("uses the flat (payload-1.0) REQUEST-authorizer context when present", () => {
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

  it("prefers the lambda context, then flat, then the nested JWT shape", () => {
    expect(
      deriveSiteId(
        /** @type {any} */ ({
          requestContext: {
            authorizer: {
              lambda: { "claims.custom:siteId": "site-lambda" },
              "claims.custom:siteId": "site-flat",
              jwt: { claims: { "custom:siteId": "site-nested" } },
            },
          },
        }),
      ),
    ).toBe("site-lambda");
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

  it("falls back to DEMO_SITE_ID only when no authorizer ran", () => {
    expect(deriveSiteId(eventWithJwtClaims(), { DEMO_SITE_ID: "demo-7" })).toBe(
      "demo-7",
    );
    expect(
      deriveSiteId(eventWithRequestContext(), { DEMO_SITE_ID: "demo-7" }),
    ).toBe("demo-7");
  });

  it("falls back to demo-site when nothing is configured and no authorizer ran", () => {
    expect(deriveSiteId(eventWithJwtClaims(), {})).toBe("demo-site");
    expect(deriveSiteId(eventWithRequestContext(), {})).toBe("demo-site");
  });

  it("fails closed when an authorizer ran but carried no siteId claim", () => {
    // The regression this guards: an authorizer/handler event-shape mismatch
    // used to fall through to the demo partition and merge every tenant's
    // data under SITE#demo-site.
    expect(() =>
      deriveSiteId(eventWithLambdaContext({ "claims.sub": "dev-1" }), {
        DEMO_SITE_ID: "demo-7",
      }),
    ).toThrow(MissingSiteClaimError);
    expect(() =>
      deriveSiteId(eventWithJwtClaims({ sub: "u-1" }), {
        DEMO_SITE_ID: "demo-7",
      }),
    ).toThrow(MissingSiteClaimError);
  });

  it("fails closed on a non-string claim", () => {
    expect(() =>
      deriveSiteId(eventWithJwtClaims({ "custom:siteId": 123 }), {
        DEMO_SITE_ID: "demo-7",
      }),
    ).toThrow(MissingSiteClaimError);
    expect(() =>
      deriveSiteId(eventWithLambdaContext({ "claims.custom:siteId": "" })),
    ).toThrow(MissingSiteClaimError);
  });
});
