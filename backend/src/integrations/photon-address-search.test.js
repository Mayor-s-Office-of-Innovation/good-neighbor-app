import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AddressSearchError,
  searchAddresses,
} from "./photon-address-search.js";

afterEach(() => vi.unstubAllGlobals());

describe("searchAddresses", () => {
  it("returns normalized San Francisco address suggestions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              osm_id: 123,
              housenumber: "1",
              street: "Dr Carlton B Goodlett Place",
              city: "San Francisco",
              state: "California",
              postcode: "94102",
            },
          },
          {
            properties: {
              osm_id: 456,
              housenumber: "1",
              street: "Dr Carlton B Goodlett Place",
              city: "San Francisco",
              state: "CA",
              postcode: "94102",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchAddresses("1 Dr Carlton")).resolves.toEqual([
      {
        id: "123",
        label: "1 Dr Carlton B Goodlett Place, San Francisco, CA 94102",
        addressParts: {
          streetNumber: "1",
          streetAddress: "Dr Carlton B Goodlett Place",
          secondLine: "",
          city: "San Francisco",
          state: "CA",
          zip: "94102",
        },
      },
    ]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("bbox")).toBe(
      "-122.5149,37.7081,-122.3569,37.8324",
    );
    expect(url.searchParams.get("layer")).toBe("house");
  });

  it("does not call Photon for fewer than three characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchAddresses("1 ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps provider failures to a stable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(searchAddresses("Market Street")).rejects.toBeInstanceOf(
      AddressSearchError,
    );
  });
});
