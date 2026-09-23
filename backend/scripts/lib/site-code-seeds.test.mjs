import { describe, expect, it, vi } from "vitest";
import { devSiteCodeSeeds, seedSiteCodes } from "./site-code-seeds.mjs";

describe("seedSiteCodes", () => {
  it("gives every seeded provider more than one site and unique login codes", () => {
    const byProvider = new Map();
    for (const seed of devSiteCodeSeeds) {
      byProvider.set(
        seed.providerId,
        (byProvider.get(seed.providerId) || 0) + 1,
      );
    }
    expect([...byProvider.values()].every((count) => count >= 2)).toBe(true);
    expect(new Set(devSiteCodeSeeds.map((seed) => seed.code)).size).toBe(
      devSiteCodeSeeds.length,
    );
  });

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

  it("does not seed a places list on any site", async () => {
    const send = vi.fn(async () => ({}));

    await seedSiteCodes({ send }, "gnp-test-app");

    for (const seed of devSiteCodeSeeds) {
      expect(seed).not.toHaveProperty("places");
    }
    const siteUpserts = send.mock.calls
      .map(([command]) => command.input)
      .filter(
        (input) =>
          input.Key?.sk === "#META" && input.Key?.pk?.startsWith("SITE#"),
      );
    expect(siteUpserts.length).toBe(devSiteCodeSeeds.length);
    for (const input of siteUpserts) {
      expect(input.UpdateExpression).not.toMatch(/places/);
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":places");
    }
  });

  it("seeds 640 Jones with its Census-geocoded address for local proximity checks", async () => {
    const send = vi.fn(async () => ({}));
    await seedSiteCodes({ send }, "gnp-test-app");
    const site = send.mock.calls
      .map(([command]) => command.input)
      .find(
        (input) =>
          input.Key?.pk === "SITE#chc-640-jones" && input.Key?.sk === "#META",
      );
    expect(site.ExpressionAttributeValues[":address"]).toBe(
      "640 Jones St, San Francisco, CA 94102",
    );
    expect(site.ExpressionAttributeValues[":location"]).toEqual({
      latitude: 37.787283046268,
      longitude: -122.413199283242,
    });
    expect(site.UpdateExpression).toContain(
      "if_not_exists(#location, :location)",
    );
  });
});
