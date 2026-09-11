import { describe, expect, it, vi } from "vitest";
import { seedSiteCodes } from "./site-code-seeds.mjs";

describe("seedSiteCodes", () => {
  it("does not reset existing dynamic setup codes", async () => {
    const send = vi.fn(async (command) => {
      if (command.input.Item?.type === "setupCode") {
        const err = new Error("already exists");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    const result = await seedSiteCodes({ send }, "gnp-test-app");

    expect(result.seededCodes).toContain("GUBSJE");
    const setupCodePuts = send.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input.Item?.type === "setupCode");
    expect(setupCodePuts.length).toBeGreaterThan(0);
    expect(setupCodePuts[0].ConditionExpression).toBe(
      "attribute_not_exists(pk)",
    );
  });
});
