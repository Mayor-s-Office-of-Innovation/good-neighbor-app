import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n.js";
import { shell } from "./describe-instead.templates.js";

describe("describe-instead template", () => {
  it("uses detailed single-issue guidance and the 20-character hint", () => {
    const markup = shell({ flowType: "single-problem", minLength: 20 });

    expect(markup).toContain(t("describe.problem.subtitle"));
    expect(markup).toContain(t("describe.hint", { count: 20 }));
    expect(markup).not.toContain(`${t("describe.hint", { count: 20 })}.`);
  });
});
