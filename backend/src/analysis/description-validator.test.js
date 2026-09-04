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
        placeName: "North",
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

  it("accepts everything when validation is explicitly disabled", async () => {
    // The escape hatch short-circuits before any model/config path, so even a
    // would-be-unconfigured production setup accepts and never gets stuck.
    process.env.NODE_ENV = "production";
    process.env.BEDROCK_ALLOW_LOCAL_STUB = "false";
    process.env.DESCRIPTION_VALIDATION_DISABLED = "true";

    await expect(
      validateDescription({
        text: "asdf",
        placeName: "North",
        modelId: "local-stub-model",
      }),
    ).resolves.toEqual({
      accepted: true,
      whatYouCanSee: true,
      whereItIs: true,
      message: "Description validation is disabled.",
    });
  });

  it("rejects stub mode outside explicit local and test environments", async () => {
    process.env.NODE_ENV = "production";
    process.env.BEDROCK_ALLOW_LOCAL_STUB = "false";

    await expect(
      validateDescription({
        text: "Trash near the gate.",
        placeName: "West",
        modelId: "local-stub-model",
      }),
    ).rejects.toMatchObject({
      code: "description_validation_not_configured",
    });
  });
});
