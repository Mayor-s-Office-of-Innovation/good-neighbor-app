import { describe, expect, it } from "vitest";
import { categoriesFor, weightingFor } from "./rubric-meta.js";

describe("rubric-meta", () => {
  it("pins all 13 good-neighbor-app v1.0.0 categories", () => {
    expect(categoriesFor("1.0.0")).toHaveLength(13);
  });

  it("resolves weighting by label", () => {
    expect(weightingFor("Needles")).toBe("High");
    expect(weightingFor("Blocking access")).toBe("Moderate");
    expect(weightingFor("Litter")).toBe("Low");
  });

  it("resolves weighting by id and is case-insensitive", () => {
    expect(weightingFor("feces_and_urine")).toBe("High");
    expect(weightingFor("  fire hazard  ")).toBe("High");
    expect(weightingFor("LITTER")).toBe("Low");
  });

  it("returns null for an unknown category so drift is visible", () => {
    expect(weightingFor("Space debris")).toBeNull();
    // @ts-expect-error — guards non-string input at runtime
    expect(weightingFor(undefined)).toBeNull();
  });

  it("returns an empty set for an unknown version", () => {
    expect(categoriesFor("9.9.9")).toEqual([]);
    expect(weightingFor("Needles", "9.9.9")).toBeNull();
  });
});
