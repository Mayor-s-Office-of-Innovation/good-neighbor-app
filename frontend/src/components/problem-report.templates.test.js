import { describe, expect, it } from "vitest";
import { shell } from "./problem-report.templates.js";

describe("single-issue capture template", () => {
  it("uses the perimeter capture shell and action styles", () => {
    const markup = shell();

    expect(markup).toContain("check-timeline single-issue");
    expect(markup).toContain('class="btn-outline check-roll__describe"');
    expect(markup).toContain('class="check-timeline__done"');
    expect(markup).toMatch(/id="submit-report"[\s\S]*?disabled/);
    expect(markup).toContain(">\n        Done\n");
  });
});
