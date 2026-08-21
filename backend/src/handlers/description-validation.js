import { jsonResponse, readJsonBody } from "../http.js";
import { validateDescription } from "../analysis/description-validator.js";

const VALID_SIDES = new Set(["North", "East", "South", "West"]);

/**
 * @param {{ validateDescription?: typeof import("../analysis/description-validator.js").validateDescription }} [deps]
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export function createHandler(deps = {}) {
  const runValidation = deps.validateDescription || validateDescription;
  return async (event) => {
    const side = event.pathParameters?.side;
    const checkId = event.pathParameters?.checkId;
    if (!checkId) {
      return jsonResponse(400, { error: "missing_check_id" });
    }
    if (!side || !VALID_SIDES.has(side)) {
      return jsonResponse(400, { error: "invalid_side" });
    }

    let parsed;
    try {
      parsed = readJsonBody(event);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    const input =
      parsed && typeof parsed === "object"
        ? /** @type {{ text?: unknown }} */ (parsed)
        : null;
    const text = String(
      input && "text" in input ? input.text || "" : "",
    ).trim();
    if (!text) {
      return jsonResponse(400, { error: "missing_text" });
    }

    try {
      const result = await runValidation({ text, side });
      return jsonResponse(200, result);
    } catch (error) {
      console.error("description validation failed", error);
      return jsonResponse(502, {
        error: "description_validation_failed",
        message: "We couldn’t check this description right now. Try again.",
      });
    }
  };
}

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const handler = createHandler();
