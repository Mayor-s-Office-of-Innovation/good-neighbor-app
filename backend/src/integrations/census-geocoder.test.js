import { afterEach, describe, expect, it, vi } from "vitest";
import { GeocodingError, geocodeAddress } from "./census-geocoder.js";

afterEach(() => vi.unstubAllGlobals());

describe("geocodeAddress", () => {
  it("returns WGS84 coordinates from the Census match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          addressMatches: [
            {
              matchedAddress:
                "1 DR CARLTON B GOODLETT PL, SAN FRANCISCO, CA, 94102",
              coordinates: { x: -122.4192, y: 37.7793 },
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102"),
    ).resolves.toEqual({
      latitude: 37.7793,
      longitude: -122.4192,
      matchedAddress: "1 DR CARLTON B GOODLETT PL, SAN FRANCISCO, CA, 94102",
    });
  });

  it("returns address_not_found when the geocoder finds no match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { addressMatches: [] } }),
      }),
    );

    await expect(geocodeAddress("No Such Address")).rejects.toMatchObject(
      new GeocodingError("address_not_found"),
    );
  });
});
