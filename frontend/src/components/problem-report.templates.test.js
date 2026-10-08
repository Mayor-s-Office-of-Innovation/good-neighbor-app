import { describe, expect, it } from "vitest";
import { shell } from "./problem-report.templates.js";

describe("single-issue capture template", () => {
  it("uses the perimeter capture shell and action styles", () => {
    const markup = shell();

    expect(markup).toContain("check-timeline single-issue");
    expect(markup).toContain('class="btn-outline check-roll__describe"');
    expect(markup).toContain('id="problem-footer"');
    expect(markup.indexOf('id="describe-instead"')).toBeLessThan(
      markup.indexOf('id="problem-footer"'),
    );
    expect(markup.indexOf('id="problem-footer"')).toBeLessThan(
      markup.indexOf('id="single-issue-analysis"'),
    );
  });
});
