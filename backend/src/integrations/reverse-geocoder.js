import {
  GeoPlacesClient,
  ReverseGeocodeCommand,
} from "@aws-sdk/client-geo-places";

const client = new GeoPlacesClient({});

/**
 * Find a nearby street address for a photo's device coordinates. The result is
 * stored with the analysis, so the request explicitly uses the Storage tier.
 * A missing/invalid coordinate or no nearby address is a normal fallback case.
 * @param {number | undefined} latitude
 * @param {number | undefined} longitude
 * @param {Pick<GeoPlacesClient, "send">} [geoClient]
 * @returns {Promise<string | null>}
 */
export async function reverseGeocodePhoto(
  latitude,
  longitude,
  geoClient = client,
) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(Number(latitude)) > 90 ||
    Math.abs(Number(longitude)) > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  const result = await geoClient.send(
    new ReverseGeocodeCommand({
      QueryPosition: [Number(longitude), Number(latitude)],
      QueryRadius: 200,
      MaxResults: 1,
      Filter: {
        IncludePlaceTypes: ["PointAddress", "InterpolatedAddress", "Street"],
      },
      Language: "en",
      IntendedUse: "Storage",
    }),
    { abortSignal: globalThis.AbortSignal.timeout(3000) },
  );
  const address = result.ResultItems?.[0]?.Address?.Label;
  return typeof address === "string" && address.trim() ? address.trim() : null;
}
