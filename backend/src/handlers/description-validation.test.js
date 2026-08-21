import { afterEach, describe, expect, it, vi } from "vitest";

const { createHandler } = await import("./description-validation.js");

describe("description validation handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires a valid side and text", async () => {
    const handler = createHandler();

    const missingText = await callHandler(handler, {
      pathParameters: { checkId: "chk-1", side: "North" },
      body: JSON.stringify({ text: "" }),
    });
    expect(missingText.statusCode).toBe(400);
    expect(JSON.parse(missingText.body)).toEqual({ error: "missing_text" });

    const invalidSide = await callHandler(handler, {
      pathParameters: { checkId: "chk-1", side: "Nope" },
      body: JSON.stringify({ text: "trash near the entrance" }),
    });
    expect(invalidSide.statusCode).toBe(400);
    expect(JSON.parse(invalidSide.body)).toEqual({ error: "invalid_side" });
  });

  it("returns structured validation results", async () => {
    const validate = vi.fn().mockResolvedValue({
      accepted: true,
      whatYouCanSee: true,
      whereItIs: true,
      message: "Description looks usable.",
    });
    const handler = createHandler({ validateDescription: validate });

    const res = await callHandler(handler, {
      pathParameters: { checkId: "chk-1", side: "West" },
      body: JSON.stringify({ text: "Trash near the west gate." }),
    });

    expect(validate).toHaveBeenCalledWith({
      text: "Trash near the west gate.",
      side: "West",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      accepted: true,
      whatYouCanSee: true,
      whereItIs: true,
      message: "Description looks usable.",
    });
  });

  it("maps validator failures to a retryable API error", async () => {
    const handler = createHandler({
      validateDescription: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const res = await callHandler(handler, {
      pathParameters: { checkId: "chk-1", side: "South" },
      body: JSON.stringify({ text: "Graffiti on the south wall." }),
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      error: "description_validation_failed",
      message: "We couldn’t check this description right now. Try again.",
    });
  });

  it("reports missing Bedrock configuration separately", async () => {
    const error = new Error("missing");
    /** @type {Error & { code: string }} */ (error).code =
      "description_validation_not_configured";
    const handler = createHandler({
      validateDescription: vi.fn().mockRejectedValue(error),
    });

    const res = await callHandler(handler, {
      pathParameters: { checkId: "chk-1", side: "South" },
      body: JSON.stringify({ text: "Graffiti on the south wall." }),
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: "description_validation_not_configured",
      message: "Description validation is not configured.",
    });
  });
});

/**
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {Partial<import("aws-lambda").APIGatewayProxyEventV2>} event
 */
async function callHandler(handler, event) {
  return /** @type {import("aws-lambda").APIGatewayProxyResult} */ (
    await handler(
      /** @type {import("aws-lambda").APIGatewayProxyEventV2} */ ({
        body: "",
        pathParameters: {},
        ...event,
      }),
      /** @type {any} */ ({}),
      () => {},
    )
  );
}
