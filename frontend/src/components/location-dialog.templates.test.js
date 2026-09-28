import { describe, expect, it } from "vitest";

import {
  locationDialog,
  locationDialogSites,
} from "./location-dialog.templates.js";

const sites = [
  { siteId: "site-a", name: "Alpha Center" },
  { siteId: "site-b", name: "Beta <Hall>" },
];

describe("locationDialogSites", () => {
  it("puts the bound site first when the catalog lacks it", () => {
    const current = { siteId: "site-x", name: "Bound" };
    expect(locationDialogSites([], current)).toEqual([current]);
    expect(locationDialogSites(sites, current).map((s) => s.siteId)).toEqual([
      "site-x",
      "site-a",
      "site-b",
    ]);
    expect(locationDialogSites(sites, sites[1])).toEqual(sites);
  });
});

describe("locationDialog", () => {
  it("names the site and presses the current option", () => {
    const markup = locationDialog({
      siteName: "Alpha Center",
      sites,
      currentSiteId: "site-b",
    });
    expect(markup).toContain("not near Alpha Center");
    expect(markup).toMatch(/data-location-site="site-b"\s+aria-pressed="true"/);
    expect(markup).toMatch(
      /data-location-site="site-a"\s+aria-pressed="false"/,
    );
    expect(markup).toMatch(/id="location-confirm"[^>]*disabled/);
  });

  it("lists provider sites and keeps site-change confirmation disabled initially", () => {
    const markup = locationDialog({
      siteName: "Mission District",
      sites: [
        { siteId: "site-1", name: "Mission District" },
        { siteId: "site-2", name: "Site 2" },
      ],
      currentSiteId: "site-1",
    });
    expect(markup).toContain("Is your app set to the right location?");
    expect(markup).toContain('<h2 id="location-dialog-title">');
    expect(markup).toContain('aria-labelledby="location-dialog-title"');
    expect(markup).toContain('aria-describedby="location-dialog-copy"');
    expect(markup).toContain("Site 2");
    expect(markup).toMatch(/location-dialog__site"\s+appearance="plain"/);
    expect(markup).toMatch(/location-dialog__confirm"\s+appearance="plain"/);
    expect(markup).toMatch(/location-dialog__stay"\s+appearance="plain"/);
    expect(markup).toMatch(/Confirm site change\s*<\/button>/);
    expect(markup).toMatch(/id="location-confirm"\s+type="button"\s+disabled/);
  });
});
