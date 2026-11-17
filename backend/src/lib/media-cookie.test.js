import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEDIA_COOKIE_TTL_SECONDS,
  mediaCookiesEnabled,
  mediaPathsFor,
  mediaPolicy,
  mintMediaCookies,
  withMediaCookies,
} from "./media-cookie.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** @returns {NodeJS.ProcessEnv} */
const enabledEnv = () => ({
  MEDIA_KEY_PAIR_ID: "K2EXAMPLE",
  MEDIA_SIGNING_KEY: PEM,
  PROVIDER_APP_URL: "https://app.example.org/",
});

/** CloudFront's URL-safe base64 back to bytes. @param {string} value */
const decode = (value) =>
  Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "=").replaceAll("~", "/"),
    "base64",
  );

/** @param {string} cookie */
const parse = (cookie) => {
  const [pair, ...attributes] = cookie.split("; ");
  const [name, value] = pair.split("=");
  return { name, value, attributes };
};

afterEach(() => {
  for (const key of [
    "MEDIA_KEY_PAIR_ID",
    "MEDIA_SIGNING_KEY",
    "MEDIA_SIGNING_KEY_SECRET_ARN",
    "PROVIDER_APP_URL",
  ])
    delete process.env[key];
});

describe("mediaCookiesEnabled", () => {
  it("is off unless the key pair id, a key source and the app origin are all set", () => {
    expect(mediaCookiesEnabled({})).toBe(false);
    expect(mediaCookiesEnabled({ MEDIA_KEY_PAIR_ID: "K" })).toBe(false);
    expect(
      mediaCookiesEnabled({
        MEDIA_KEY_PAIR_ID: "K",
        MEDIA_SIGNING_KEY_SECRET_ARN: "arn",
      }),
    ).toBe(false);
    expect(mediaCookiesEnabled(enabledEnv())).toBe(true);
  });
});

describe("mediaPathsFor", () => {
  const scope = { siteId: "site-1", checkId: "chk_01", env: enabledEnv() };

  it("returns nothing when the feature is off", () => {
    expect(
      mediaPathsFor(
        { s3Key: "checks/site-1/chk_01/a", contentType: "image/jpeg" },
        { ...scope, env: {} },
      ),
    ).toEqual({});
  });

  it("maps the original and thumbnail under the media prefix", () => {
    expect(
      mediaPathsFor(
        {
          s3Key: "checks/site-1/chk_01/a",
          thumbS3Key: "checks/site-1/chk_01/a.thumb.webp",
          contentType: "image/jpeg",
        },
        scope,
      ),
    ).toEqual({
      mediaPath: "/checks/site-1/chk_01/a",
      thumbnailPath: "/checks/site-1/chk_01/a.thumb.webp",
    });
  });

  it("omits a missing thumbnail", () => {
    expect(
      mediaPathsFor(
        { s3Key: "checks/site-1/chk_01/a", contentType: "image/webp" },
        scope,
      ),
    ).toEqual({ mediaPath: "/checks/site-1/chk_01/a" });
  });

  it("never emits a path outside the caller's tenant prefix", () => {
    expect(
      mediaPathsFor(
        { s3Key: "checks/site-2/chk_01/a", contentType: "image/jpeg" },
        scope,
      ),
    ).toEqual({});
    expect(
      mediaPathsFor(
        {
          s3Key: "checks/site-1/chk_01/a",
          thumbS3Key: "checks/site-1/other/a.thumb.webp",
          contentType: "image/jpeg",
        },
        scope,
      ),
    ).toEqual({ mediaPath: "/checks/site-1/chk_01/a" });
    expect(
      mediaPathsFor(
        { s3Key: "checks/site-1/chk_01/../x", contentType: "image/jpeg" },
        scope,
      ),
    ).toEqual({});
  });

  it("ignores text evidence and prefers a task-update display variant", () => {
    expect(
      mediaPathsFor(
        { s3Key: "checks/site-1/chk_01/t", contentType: "text/plain" },
        scope,
      ),
    ).toEqual({});
    expect(
      mediaPathsFor(
        {
          entityType: "task_update_media",
          s3Key: "checks/site-1/chk_01/u",
          displayS3Key: "checks/site-1/chk_01/u.display.jpg",
          contentType: "image/jpeg",
        },
        scope,
      ),
    ).toEqual({ mediaPath: "/checks/site-1/chk_01/u.display.jpg" });
  });
});

describe("mintMediaCookies", () => {
  it("returns no cookies when the feature is off", async () => {
    expect(await mintMediaCookies("site-1", { env: {} })).toEqual([]);
  });

  it("signs a one-hour policy for the site prefix that the public key verifies", async () => {
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cookies = await mintMediaCookies("site-1", {
      env: enabledEnv(),
      now,
    });
    const byName = Object.fromEntries(
      cookies.map(parse).map((c) => [c.name, c]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      "CloudFront-Key-Pair-Id",
      "CloudFront-Policy",
      "CloudFront-Signature",
    ]);
    expect(byName["CloudFront-Key-Pair-Id"].value).toBe("K2EXAMPLE");

    const policy = decode(byName["CloudFront-Policy"].value).toString("utf8");
    expect(policy).toBe(
      mediaPolicy({
        siteId: "site-1",
        origin: "https://app.example.org",
        expiresAt: Math.floor(now / 1000) + MEDIA_COOKIE_TTL_SECONDS,
      }),
    );
    expect(JSON.parse(policy).Statement[0].Resource).toBe(
      "https://app.example.org/checks/site-1/*",
    );

    const verifier = createVerify("RSA-SHA1");
    verifier.update(policy);
    expect(
      verifier.verify(publicKey, decode(byName["CloudFront-Signature"].value)),
    ).toBe(true);

    for (const cookie of Object.values(byName)) {
      expect(cookie.attributes).toEqual([
        "Path=/checks",
        `Max-Age=${MEDIA_COOKIE_TTL_SECONDS}`,
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
      ]);
      expect(cookie.value).not.toMatch(/[+=/]/);
    }
  });

  it("refuses a site id that could widen the policy", async () => {
    await expect(
      mintMediaCookies("site-1/*", { env: enabledEnv() }),
    ).rejects.toThrow(/Unsafe siteId/);
  });
});

describe("withMediaCookies", () => {
  it("leaves the response alone when the feature is off", async () => {
    const response = { statusCode: 200, body: "{}" };
    expect(await withMediaCookies(response, "site-1", { env: {} })).toBe(
      response,
    );
    expect(response).not.toHaveProperty("cookies");
  });

  it("appends the three cookies to the payload-2.0 cookies array", async () => {
    const response = { statusCode: 200, body: "{}", cookies: ["x=1"] };
    await withMediaCookies(response, "site-1", { env: enabledEnv() });
    expect(response.cookies).toHaveLength(4);
    expect(response.cookies?.[0]).toBe("x=1");
  });

  it("never fails the session response when signing fails", async () => {
    const response = { statusCode: 200, body: "{}" };
    const env = { ...enabledEnv(), MEDIA_SIGNING_KEY: "not a key" };
    expect(await withMediaCookies(response, "site-1", { env })).toBe(response);
    expect(response).not.toHaveProperty("cookies");
  });
});
