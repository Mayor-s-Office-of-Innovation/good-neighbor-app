import { describe, expect, it } from "vitest";
import { errorView } from "./site-info-shell.js";
import { t } from "../i18n/i18n.js";

describe("site info error navigation", () => {
  it("keeps back navigation on child and root errors", () => {
    expect(errorView("Synthetic error")).toContain('name="chevron-left"');
    expect(errorView("Synthetic error")).toContain(
      `aria-label="${t("common.back")}"`,
    );
    expect(errorView("Synthetic error", true)).toContain('name="chevron-left"');
    expect(errorView("Synthetic error", true)).toContain(
      `aria-label="${t("common.back")}"`,
    );
  });
});
