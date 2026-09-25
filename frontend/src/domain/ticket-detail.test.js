import { describe, expect, it } from "vitest";
import { ticketDetailLocation } from "./ticket-detail.js";

describe("ticketDetailLocation", () => {
  it("uses the first line of the photo location first", () => {
    expect(
      ticketDetailLocation(
        {
          evidence: {
            georeferencedAddress: "15th St, San Francisco, CA",
            placeName: "Photo place",
          },
          siteAddress: "Site address, San Francisco",
        },
        { name: "Site name" },
        {},
      ),
    ).toBe("15th St");
  });

  it("falls back to site address, then site name", () => {
    expect(
      ticketDetailLocation(
        { evidence: { placeName: "Photo place" } },
        { address: "640 Jones St, San Francisco", name: "Site name" },
        {},
      ),
    ).toBe("640 Jones St");
    expect(ticketDetailLocation({}, { name: "Site name" }, {})).toBe(
      "Site name",
    );
  });
});
