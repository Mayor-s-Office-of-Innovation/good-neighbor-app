import { jsonResponse } from "../http.js";
import { validateSetupCode } from "./setup-codes.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const handler = async (event) => {
  const body = parseJson(event.body);
  const code = normalizeSiteCode(
    typeof body?.code === "string" ? body.code : "",
  );

  if (!code) {
    return jsonResponse(400, { error: "missing_site_code" });
  }

  const valid = await validateSetupCode(code);
  if (!valid) {
    return jsonResponse(401, { error: "invalid_site_code" });
  }

  return jsonResponse(200, {
    code,
    providerSite: {
      id: valid.providerSiteId,
      siteId: valid.siteId,
      name: valid.siteName,
    },
  });
};

/**
 * @param {string | undefined} body
 * @returns {Record<string, unknown> | null}
 */
function parseJson(body) {
  if (!body) return null;
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Codes are stored as uppercase alphanumerics without visual separators, so
 * "123-456", "123 456", and "123456" resolve to the same provider site.
 * @param {string} code
 * @returns {string}
 */
export function normalizeSiteCode(code) {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
