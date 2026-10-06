import { jsonResponse } from "../http.js";
import {
  AddressSearchError,
  searchAddresses,
} from "../integrations/photon-address-search.js";
import { adminOnly } from "../lib/admin-auth.js";

/** POST /admin/v1/address-suggestions */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const suggestAddresses = (event) =>
  adminOnly(event, async (body) => {
    const query = String(body.query ?? "").trim();
    if (query.length < 3 || query.length > 160) {
      return jsonResponse(400, { error: "invalid_address_query" });
    }
    try {
      return jsonResponse(200, {
        suggestions: await searchAddresses(query),
      });
    } catch (error) {
      if (error instanceof AddressSearchError) {
        return jsonResponse(503, { error: error.message });
      }
      throw error;
    }
  });
