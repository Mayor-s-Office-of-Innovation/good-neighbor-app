import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The site catalog error toast stays quiet during an outage: the "You're
  offline" toast already covers it. Health state is mocked so each case sets
  it directly.
*/

const health = vi.hoisted(() => ({ state: "healthy" }));
vi.mock("../services/backend-health.js", () => ({
  getHealthState: () => health.state,
}));

const { t } = await import("../i18n/i18n.js");
const { getToasts, showSiteCatalogErrorToast } = await import("./toasts.js");

function catalogToasts() {
  return getToasts().filter(
    (toast) => toast.title === t("toast.siteCatalogError.title"),
  );
}

describe("showSiteCatalogErrorToast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    getToasts().forEach((toast) => toast.close(true));
    vi.useRealTimers();
  });

  it("is skipped while the API is unreachable", () => {
    health.state = "outage";
    expect(showSiteCatalogErrorToast()).toBeNull();
    expect(catalogToasts()).toHaveLength(0);
  });

  it.each(["healthy", "auth", "access"])(
    "shows when the health state is %s",
    (state) => {
      health.state = state;
      expect(showSiteCatalogErrorToast()).toMatchObject({
        title: t("toast.siteCatalogError.title"),
        tone: "error",
      });
      expect(catalogToasts()).toHaveLength(1);
    },
  );
});
