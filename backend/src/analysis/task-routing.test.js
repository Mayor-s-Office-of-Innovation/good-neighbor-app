import { describe, expect, it } from "vitest";
import { classifyTask } from "./task-routing.js";

// These assert the PLACEHOLDER routing behaviour (see task-routing.js header).
// When the product team defines the real matrix, update these alongside it.
describe("classifyTask (placeholder matrix)", () => {
  it("produces no task for a zero severity", () => {
    expect(classifyTask("Litter", 0)).toBeNull();
  });

  it("routes routine concerns to on-site staff", () => {
    expect(classifyTask("Litter", 2)).toBe("onsite");
    expect(classifyTask("Graffiti", 4)).toBe("onsite");
  });

  it("escalates hazardous concerns at high severity to the city", () => {
    expect(classifyTask("Hazardous materials", 3)).toBe("city_escalation");
    expect(classifyTask("Discarded needles", 5)).toBe("city_escalation");
  });

  it("keeps a hazardous concern on-site when severity is below the escalation floor", () => {
    expect(classifyTask("Chemical spill", 2)).toBe("onsite");
  });
});
