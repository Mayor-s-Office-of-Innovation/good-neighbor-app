import providerModule from "@aws-sdk/credential-provider-node";
import { jsonResponse, readJsonBody } from "../http.js";

const { defaultProvider } = providerModule;

/**
 * Local/dev passthrough cred vending for browser-direct Transcribe streaming.
 * This is intentionally disabled unless `TRANSCRIBE_CREDENTIALS_MODE=passthrough`
 * is set in the backend environment. That keeps the route inert in deployed
 * environments until the real device-token + scoped STS path lands.
 * @param {{ credentialProvider?: () => Promise<any>, region?: string, profile?: string }} [deps]
 * @returns {Promise<{ accessKeyId: string, secretAccessKey: string, sessionToken: string | null, expiration: string | null, region: string }>}
 */
export async function resolvePassthroughCredentials(deps = {}) {
  const profile = deps.profile || process.env.TRANSCRIBE_AWS_PROFILE;
  const credentialProvider =
    deps.credentialProvider ||
    defaultProvider(profile ? { profile } : undefined);
  const region = deps.region || process.env.AWS_REGION || "us-east-1";
  const credentials = await credentialProvider();
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("AWS credentials are not available for passthrough.");
  }
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken || null,
    expiration:
      credentials.expiration &&
      typeof credentials.expiration.toISOString === "function"
        ? credentials.expiration.toISOString()
        : null,
    region,
  };
}

/**
 * @param {{ credentialProvider?: () => Promise<any>, region?: string, profile?: string }} [deps]
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export function createHandler(deps = {}) {
  return async (event) => {
    let parsed;
    try {
      parsed = readJsonBody(event);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    const body =
      parsed && typeof parsed === "object"
        ? /** @type {{ siteId?: unknown }} */ (parsed)
        : null;

    if (typeof body?.siteId !== "string" || !body.siteId.trim()) {
      return jsonResponse(400, { error: "missing_site_id" });
    }

    if (process.env.TRANSCRIBE_CREDENTIALS_MODE !== "passthrough") {
      return jsonResponse(501, {
        error: "transcribe_not_configured",
        message:
          "Transcribe credentials are not configured for this environment.",
      });
    }

    try {
      const credentials = await resolvePassthroughCredentials({
        credentialProvider: deps.credentialProvider,
        region: deps.region,
        profile: deps.profile,
      });
      return jsonResponse(200, credentials);
    } catch (error) {
      console.error("transcribe credential resolution failed", error);
      return jsonResponse(503, {
        error: "transcribe_credentials_unavailable",
        message:
          "Could not resolve AWS credentials for browser-direct transcription.",
      });
    }
  };
}

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const handler = createHandler();
