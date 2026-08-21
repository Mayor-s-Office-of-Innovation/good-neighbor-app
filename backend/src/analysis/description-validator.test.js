import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDescription } from "./description-validator.js";

const env = { ...process.env };

describe("validateDescription", () => {
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("derives accepted from the required booleans, not model output", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        output: {
          message: {
            content: [
              {
                text: JSON.stringify({
                  accepted: true,
                  whatYouCanSee: true,
                  whereItIs: false,
                  message: "looks good",
                }),
              },
            ],
          },
        },
      }),
    };

    await expect(
      validateDescription({
        text: "Trash.",
        side: "North",
        modelId: "model-id",
        client,
      }),
    ).resolves.toEqual({
      accepted: false,
      whatYouCanSee: true,
      whereItIs: false,
      message: "looks good",
    });
  });

  it("rejects stub mode outside explicit local and test environments", async () => {
    process.env.NODE_ENV = "production";
    process.env.BEDROCK_ALLOW_LOCAL_STUB = "false";

    await expect(
      validateDescription({
        text: "Trash near the gate.",
        side: "West",
        modelId: "local-stub-model",
      }),
    ).rejects.toMatchObject({
      code: "description_validation_not_configured",
    });
  });
});
