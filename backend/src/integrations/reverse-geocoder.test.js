import { ReverseGeocodeCommand } from "@aws-sdk/client-geo-places";
import { describe, expect, it, vi } from "vitest";
import { reverseGeocodePhoto } from "./reverse-geocoder.js";

describe("photo reverse geocoding", () => {
  it("sends longitude before latitude and permits storage of the result", async () => {
    const send = vi.fn().mockResolvedValue({
      ResultItems: [{ Address: { Label: "640 Jones St, San Francisco, CA" } }],
    });

    const address = await reverseGeocodePhoto(
      37.7881,
      -122.4132,
      /** @type {any} */ ({ send }),
    );

    expect(address).toBe("640 Jones St, San Francisco, CA");
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(ReverseGeocodeCommand);
    expect(command.input).toMatchObject({
      QueryPosition: [-122.4132, 37.7881],
      QueryRadius: 200,
      MaxResults: 1,
      IntendedUse: "Storage",
    });
  });

  it("skips missing, invalid, and placeholder coordinates", async () => {
    const send = vi.fn();
    const geoClient = /** @type {any} */ ({ send });
    expect(await reverseGeocodePhoto(undefined, -122, geoClient)).toBeNull();
    expect(await reverseGeocodePhoto(91, -122, geoClient)).toBeNull();
    expect(await reverseGeocodePhoto(0, 0, geoClient)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("returns null when no nearby address is found", async () => {
    const send = vi.fn().mockResolvedValue({ ResultItems: [] });
    expect(
      await reverseGeocodePhoto(
        37.7881,
        -122.4132,
        /** @type {any} */ ({ send }),
      ),
    ).toBeNull();
  });
});
