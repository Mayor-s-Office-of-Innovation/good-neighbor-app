import { describe, expect, it } from "vitest";
import { shell } from "./describe-instead.templates.js";

describe("describe-instead template", () => {
  it("uses detailed single-issue guidance and the 20-character hint", () => {
    const markup = shell({ flowType: "single-problem", minLength: 20 });

    expect(markup).toContain(
      "Describe the issue you see in as much detail as possible",
    );
    expect(markup).toContain("At least 20 characters");
    expect(markup).not.toContain("At least 20 characters.");
  });
});
