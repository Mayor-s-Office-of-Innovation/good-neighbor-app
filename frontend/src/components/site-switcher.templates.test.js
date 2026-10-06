import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import { siteSwitcher, switcherSites } from "./site-switcher.templates.js";

const sites = [
  { siteId: "site-a", name: "Alpha Center" },
  { siteId: "site-b", name: "Beta <Hall>" },
];

describe("switcherSites", () => {
  it("falls back to the bound site and always includes it", () => {
    const current = { siteId: "site-x", name: "Bound" };
    expect(switcherSites([], current)).toEqual([current]);
    expect(switcherSites(sites, current).map((s) => s.siteId)).toEqual([
      "site-a",
      "site-b",
      "site-x",
    ]);
    expect(switcherSites(sites, sites[0])).toEqual(sites);
  });
});

describe("siteSwitcher", () => {
  it("lists sites with the current one marked only while open", () => {
    const closed = siteSwitcher({
      providerName: "Provider One",
      sites,
      currentSiteId: "site-a",
      open: false,
      status: "loaded",
    });
    expect(closed).toContain("Provider One");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('id="site-switcher-list"');

    const open = siteSwitcher({
      providerName: "",
      sites,
      currentSiteId: "site-a",
      open: true,
      status: "loaded",
    });
    expect(open).toContain(t("siteSwitcher.providerFallback"));
    expect(open).toContain('data-switch-site="site-a"');
    expect(open).toContain('aria-current="page"');
    expect(open).toContain("Beta &lt;Hall&gt;");
    expect(open).not.toContain("Beta <Hall>");
  });

  it("shows loading and a retry control after catalog failure", () => {
    const base = {
      providerName: "P",
      sites,
      currentSiteId: "site-a",
      open: true,
    };
    expect(siteSwitcher({ ...base, status: "loading" })).toContain(
      t("siteSwitcher.loading"),
    );
    expect(siteSwitcher({ ...base, status: "error" })).toContain(
      'id="site-catalog-retry"',
    );
  });
});

describe("siteSwitcher menu", () => {
  it("lists provider sites without add-site or generic login actions", () => {
    const menu = siteSwitcher({
      providerName: "CHC",
      sites: [
        { siteId: "chc-640-jones", name: "640 Jones" },
        { siteId: "chc-730-polk", name: "730 Polk" },
      ],
      currentSiteId: "chc-730-polk",
      open: true,
      status: "loaded",
    });
    expect(menu).toContain("640 Jones");
    expect(menu).toContain("730 Polk");
    expect(menu).toContain("home-site-switcher__item--selected");
    expect(menu).not.toContain("Add another site");
    expect(menu).not.toContain("Login to another site");
  });
});
